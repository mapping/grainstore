var _      = require('underscore'),
    base64 = require('./base64'),
    Step   = require('step'),
    carto  = require('carto'),
    millstone = require('millstone'),
    fs     = require('fs'),
    StyleTrans = require('./style_trans'),
    semver = require('semver')
;

// MML builder interface
//
// `redis` should be an instance of RedisPool
//
// opts must have:
// `dbname`    - name of database
// `table` - name of table with geospatial data
// 
// opts may have:
// `sql`             - sql to constrain the map by
// `geom_type`       - [polygon|point] to specify which default style to use
// `style`           - Carto style to override the built in style store
// `style_version`   - Version of the carto style override
// `mapnik_version`  - Target version of mapnik, defaults to ``latest``
//
// @param optional_args
//     You may pass in a third argument to override grainstore defaults. 
//     `map` specifies the output map projection.
//     `datasource` specifies postgis details from Mapnik postgis plugin:
//                  https://github.com/mapnik/mapnik/wiki 
//     `styles` specifies the default styles
//     `cachedir` is base directory to put localized external resources into
//
//     eg.
//     {
//       map: {srid: 3857},
//       datasource: {
//         type: "postgis",
//         host: "localhost",
//         user: "postgres",
//         geometry_field: "the_geom_webmercator",
//         extent: "-20037508.3,-20037508.3,20037508.3,20037508.3",
//         srid: 3857,
//         max_size: 10
//       },
//       styles: {
//         point: "default point style",
//         polygon: "default polygon style",  
//       }
//     }
//
// @param init_callback
//   init_callback(err, payload) will be invoked on complete initialization
//   see me.init for more info
//
var MMLBuilder = function(redis_pool, opts, optional_args, init_callback){

    // The init_callback parameter is optional
    init_callback = init_callback || function() {};

    // core variables
    var opts = opts || {};
    var opt_keys = _.keys(opts);
    if (!_.include(opt_keys,'dbname') || !_.include(opt_keys, 'table'))
        throw new Error("Options must include dbname and table");
    var geom_type      = opts.geom_type || 'point';   // geom type for default styling

    var extra_config          = optional_args           || {};

    var target_mapnik_version = extra_config.mapnik_version || '2.0.2';
    var default_style_version = extra_config.default_style_version || '2.0.0';

    // configure grainstore from optional args passed + defaults
    var grainstore_defaults = {
        map: {
            srid: 3857
        },
        datasource: {
            type: "postgis",
            host: "localhost",
            user: "postgres",
            geometry_field: "the_geom_webmercator",
            extent: "-20037508.3,-20037508.3,20037508.3,20037508.3",
            srid: 3857,
            max_size: 10
        },
        styles: {
            db: 0  // redis database to store styles
        }
    };

    if ( semver.satisfies(target_mapnik_version, '< 2.1.0') )
    {
      var def_style_point = " {marker-fill: #FF6600;marker-opacity: 1;marker-width: 8;marker-line-color: white;marker-line-width: 3;marker-line-opacity: 0.9;marker-placement: point;marker-type: ellipse;marker-allow-overlap: true;}";
      var def_style_line = " {line-color:#FF6600; line-width:1; line-opacity: 0.7;}";
      var def_style_poly = " {polygon-fill:#FF6600; polygon-opacity: 0.7; line-opacity:1; line-color: #FFFFFF;}";
      grainstore_defaults.styles.point = '#' + opts.table + def_style_point;
      grainstore_defaults.styles.polygon = '#' + opts.table + def_style_poly;
      grainstore_defaults.styles.multipolygon = grainstore_defaults.styles.polygon;
      grainstore_defaults.styles.multilinestring = '#' + opts.table + def_style_line;
      grainstore_defaults.styles.version = '2.0.0';
    }
    else
    {
      var def_style_point = " {marker-fill: #FF6600;marker-opacity: 1;marker-width: 16;marker-line-color: white;marker-line-width: 3;marker-line-opacity: 0.9;marker-placement: point;marker-type: ellipse;marker-allow-overlap: true;}";
      var def_style_line = " {line-color:#FF6600; line-width:1; line-opacity: 0.7;}";
      var def_style_poly = " {polygon-fill:#FF6600; polygon-opacity: 0.7; line-opacity:1; line-color: #FFFFFF;}";

      grainstore_defaults.styles.point = 
        grainstore_defaults.styles.polygon = 
        grainstore_defaults.styles.multipolygon = 
        grainstore_defaults.styles.multilinestring = 
        grainstore_defaults.styles.geometry = 
        '#' + opts.table + '[mapnik-geometry-type=1]' + def_style_point +
        '#' + opts.table + '[mapnik-geometry-type=2]' + def_style_line +
        '#' + opts.table + '[mapnik-geometry-type=3]' + def_style_poly
      ;
      grainstore_defaults.styles.version = target_mapnik_version;
    }

    var grainstore_map        = extra_config.map        || {};
    // NOTE: we clone this to avoid changing default settings with an override
    var grainstore_datasource = extra_config.datasource ? _.clone(extra_config.datasource) : {};
    var grainstore_styles     = extra_config.styles     || {};

    grainstore_map        = _.defaults(grainstore_map, grainstore_defaults.map);
    grainstore_datasource = _.defaults(grainstore_datasource, grainstore_defaults.datasource);
    grainstore_styles     = _.defaults(grainstore_styles, grainstore_defaults.styles);

    // Allow overriding db authentication with options
    if ( opts.dbuser ) grainstore_datasource.user = opts.dbuser;
    if ( opts.dbpassword ) grainstore_datasource.password = opts.dbpassword;

    // Millstone configuration
    //
    // Localized resources are not shared between "layers",
    // so we can safely purge them whenever redis keys for the style
    // are purged (setStyle, delStyle)
    //
    var millstone_cachedir = extra_config.cachedir || '/tmp/millstone'; 
        millstone_cachedir += '/' + opts.dbname + '/' + opts.table;
    var millstone_base_options = {
        base:  millstone_cachedir +  '/base',
        cache: millstone_cachedir + '/cache'
    };

    // MML Builder definition
    var me = {};

    // setup XML for this object in Redis. Either from base, or from defaults.
    //
    // @param callback(err, style_payload) gets called with the string version
    //        of the style payload, which can be parsed by JSON.parse
    //
    me.init = function(callback){
        var that = this;
        var store_key = extended_store_key || base_store_key;
        var redis_client;
        var style;
        var style_version;
        var xml;
        var xml_version;
        var style_only_in_base = ( store_key != base_store_key && _.isNull(style_override) );

        Step(
            function getRedisClient(){
                redis_pool.acquire(grainstore_styles.db, this);
            },
            function getStyleAndXML(err, data){
                if (err) throw err;
                redis_client = data;
                redis_client.GET(store_key, this);
            },
            function initCheck(err, data){
                if (err) throw err;

                do { 

                  if (_.isNull(data)) break; // no redis record

                  var record = JSON.parse(data);
                  if ( ! record.xml ) break; // no XML in record

                  if ( ! record.xml_version ) break; // no xml_version in record

                  // XML target mapnik version mismatch
                  if ( record.xml_version != target_mapnik_version ) break;

                  // All checks passed, nothing more to do here
                  if (!_.isUndefined(redis_client))
                      redis_pool.release(grainstore_styles.db, redis_client);
                  callback(err, data);
                  return;

                } while (0);

                // XML needs to be re-generated, go on
                if ( !_.isNull(style_override) ) return null;

                // Keep an eye on base_store_key so that if anyone
                // changes the base style we don't override the
                // rendered ones.
                // See https://github.com/Vizzuality/grainstore/issues/27
                redis_client.WATCH(base_store_key);
                redis_client.GET(base_store_key, this);
                return;

            },
            function renderBaseStyleOrDefaultOrOverride(err, data){
                if (err) throw err;
                if (_.isNull(data)){
                    if ( ! grainstore_styles.hasOwnProperty(geom_type) ) {
                      throw new Error("No style available for geometry of type '" + geom_type + "'"); 
                    }
                    style = grainstore_styles[geom_type];
                    style_version = grainstore_styles['version'];
                } else {
                    var parsed = JSON.parse(data);
                    style = parsed.style;
                    style_version = parsed.version || default_style_version;
                }
                if (!_.isNull(style_override)){
                    style = style_override;
                    style_version = style_version_override;
                }
                that.render(style, this, style_version);
            },
            function setStore(err, compiled_XML){
                if (err) throw err;
                xml = compiled_XML;
                var tostore = {xml: compiled_XML, xml_version: target_mapnik_version };
                if ( store_key == base_store_key ) {
                  tostore.style = style;
                  tostore.version = style_version;
                }
                var payload = JSON.stringify(tostore);
                var redis_transaction = redis_client.MULTI();
                redis_transaction.SET(store_key, payload);
                if ( style_only_in_base ) { 
                  var tostore = {style: style, version: style_version};
                  var payload = JSON.stringify(tostore);
                  redis_transaction.SET(base_store_key, payload, this);
                }
                // This transaction will have NO effect IFF
                // the value of base_store_key changed since we
                // looked at it. See WATCH above.
                redis_transaction.EXEC(this);
            },
            function callbackExit(err, data){
                // NOTE: data will be an array of responses
                //       from each of the commands sent in
                //       the transaction above.
                if (!_.isUndefined(redis_client))
                    redis_pool.release(grainstore_styles.db, redis_client);
                callback(err, JSON.stringify({style: style, xml: xml}));
            }
        );
    };


    // render CartoCSS to Mapnik XML
    //
    // @param style the CartoCSS
    // @param version the version of the given CartoCSS
    // 
    me.render = function(style, callback, version){

        if ( ! version ) version = default_style_version;

        if ( version != target_mapnik_version ) {
          try {
            var t = new StyleTrans();
            style = t.transform(style, version, target_mapnik_version);
          }
          catch (err) {
            callback(err, null);
            return;
          }
        }

        var mml = this.toMML(style);

        var millstone_options = _.extend({mml:mml}, millstone_base_options);
        millstone.resolve(millstone_options, function(err, mml) {
//console.log("Resolved mml: "); console.dir(mml);

          if ( err ) {
            callback(err, null);
            return;
          }

          var carto_env = {};
          var carto_options = { mapnik_version: target_mapnik_version };

          // carto.Renderer may throw during parse time (before nextTick is called)
          // See https://github.com/mapbox/carto/pull/187
          try { 
          new carto.Renderer(carto_env, carto_options).render(mml, function(err, output){
              callback(err, output);
          });
          } catch (err) { callback(err, null); }

        });


    };


    // Purge cache of localized resources for this store
    me.purgeLocalizedResourceCache = function(callback)
    {
      // TODO: check if "base" should also be cleared
      var toclear = millstone_cachedir + '/cache';
      fs.readdir(toclear, function(err, files) {
        if ( err ) {
          if ( err.code != 'ENOENT' ) callback(err)
          else callback(null); // nothing to clear
        }
        else {
          var left = files.length;
          if ( ! left ) callback(null);
          _.each(files, function(name) {
            var file = toclear + '/' + name;
            //console.log("Unlinking " + file);
            fs.unlink(file, function(err) {
              if (err) console.log("Error unlinking " + file + ": " + err);
              if ( ! --left ) callback(null);
            });
          });
        }
      });
    };

    // Re-generate Mapnik XML from current MML.
    me.resetStyle = function(callback, convert){
      var that = this;
      that.getStyle(function(err, style) {
        return that.setStyle(style.style, callback, style.version, convert);
      });
    };

    // Generate Mapnik XML from MML.
    // store passed style and generated XML
    // Pass back any cartocss compile errors
    //
    // generates XML and stores it on base key
    // deletes all associated extended_store_keys as they
    // need to be regenerated
    me.setStyle = function(style, callback, version, convert){
        var that = this
            , redis_client
            , compiled_XML;

        if ( ! version ) version = default_style_version;

        if ( convert && version != target_mapnik_version ) {
          try {
            var t = new StyleTrans();
            style = t.transform(style, version, target_mapnik_version);
            version = target_mapnik_version;
          }
          catch (err) {
            callback(err, null);
            return;
          }
        }

        Step(
            // Purge millstone cache before refilling it
            function purgeCache(){
                that.purgeLocalizedResourceCache(this);
            },
            function renderMapnikStylesheet(err){
                if (err) throw err;
                that.render(style, this, version);
            },
            function getRedisClient(err, data){
                if (err) throw err;
                compiled_XML = data;
                redis_pool.acquire(grainstore_styles.db, this);
            },
            function storeStyleAndXML(err, data){
                if (err) throw err;
                redis_client = data;
                if ( _.isNull(style_override) )  {
                  redis_client.SET(base_store_key, JSON.stringify({
                    style: style,
                    version: version,
                    xml: compiled_XML,
                    xml_version: target_mapnik_version}), this);
                } else {
                  // Don't bother setting anything in redis as redis keys
                  // are going to be killed anyway, but tweak the
                  // extended_store_key anyway so next call to toXML
                  // won't recreate the old key
                  style_override = style;
                  style_version_override = version;
                  extended_store_key = that.makeExtendedKey();
                  return null;
                }
            },
            function getRelatedKeys(err, data){
                if (err) throw err;
                redis_client.KEYS(base_store_key + '|*', this);
            },
            function deleteRelatedKeys(err, data){
                if (err) throw err;
                if (_.isEmpty(data)) {
                    return null;
                } else {
                    redis_client.DEL(data, this);
                }
            },
            function callbackExit(err, data){
                if (!_.isUndefined(redis_client))
                    redis_pool.release(grainstore_styles.db, redis_client);
                callback(err, data);
            }
        );
    };

    // Delete style caches from redis
    // NOTE: deletes both _base_ and _related_ keys
    me.delStyle = function(callback){
        var that = this
            , redis_client;

        Step(
            // Purge millstone cache before refilling it
            function purgeCache(){
                that.purgeLocalizedResourceCache(this);
            },
            function getRedisClient(err){
                if (err) throw err;
                redis_pool.acquire(grainstore_styles.db, this);
            },
            function DelStyleAndXML(err, data){
                if (err) throw err;
                redis_client = data;
                redis_client.DEL(base_store_key, this);
            },
            function getRelatedKeys(err, data){
                if (err) throw err;
                redis_client.KEYS(base_store_key + '|*', this);
            },
            function deleteRelatedKeys(err, data){
                if (err) throw err;
                if (_.isEmpty(data)) {
                    return null;
                } else {
                    redis_client.DEL(data, this);
                }
            },
            function callbackExit(err, data){
                if (!_.isUndefined(redis_client))
                    redis_pool.release(grainstore_styles.db, redis_client);
                callback(err, data);
            }
        );
    };

    // @param callback function(err, payload)
    //                 The payload is an object containing
    //                 "style" (CartoCSS) and "version" members
    //
    // @param convert if true it will return the style in the configured
    //                target mapnik version
    me.getStyle = function(callback, convert){
        var that = this;
        var redis_client;

        Step(
            function initStyle(){
                that.init(this);
            },
            function getRedisClient(err, data){
                if (err) throw err;
                redis_pool.acquire(grainstore_styles.db, this);
            },
            function getStyleAndXML(err, data){
                if (err) throw err;
                redis_client = data;
                redis_client.GET(base_store_key, this);
            },
            function callbackExit(err, data){
                if (!_.isUndefined(redis_client))
                    redis_pool.release(grainstore_styles.db, redis_client);
                if ( err ) { callback(err, null); return; }
                var parsed = JSON.parse(data);
                if ( convert && parsed.version != target_mapnik_version ) {
                  var t = new StyleTrans();
                  parsed.style = t.transform(parsed.style, parsed.version, target_mapnik_version);
                  parsed.version = target_mapnik_version;
                }
                callback(err, parsed);
            }
        );
    };


    me.toXML = function(callback){
        this.init(function(err, data) {
            if (err) {
                callback(err, null);
            } else {
                callback(err, JSON.parse(data).xml);
            }
        });
    };

    me.toMML = function(style){
        var stylesheet  = {};
        stylesheet.id   = 'style.mss';
        stylesheet.data = style;

        var base_mml = this.baseMML();
        base_mml.Stylesheet = [stylesheet];

        return base_mml;
    };


    // Generate base MML for this object
    // opts:
    // `use_sql` - {Boolean} if true, use sql settings in MML, else use table
    me.baseMML = function(args){
        args = args || {};
        args = _.defaults(args, {use_sql: true});

        var datasource     = _.clone(grainstore_datasource);
        datasource.table   = (args.use_sql && !_.isUndefined(opts.sql)) ? opts.sql : opts.table;
        datasource.dbname  = opts.dbname;

        var layer        = {};
        layer.id         = opts.table;
        layer.name       = opts.table;
        layer.srs        = '+init=epsg:' + grainstore_datasource.srid; //layer.srs = srs.parse(layer.srs).proj4;
        layer.Datasource = datasource;

        var mml   = {};
        mml.srs   = '+init=epsg:' + grainstore_map.srid; // mml.srs = srs.parse(mml.srs).proj4;
        mml.Layer = [layer];

        return mml;
    };

    // Bases extended key on:
    //   base_store_key
    //   opts.sql
    //   style_override
    //   style_version_override
    //  
    me.makeExtendedKey = function() {
      if ( ! opts.sql && ! style_override ) return; // no extended key needed
      var key = base_store_key;
      if ( opts.sql ) key += '|' + base64.encode(opts.sql);
      if ( style_override ) key += '|' + base64.encode(style_override + '|' + style_version_override);
      return key;
    }

    var style_override = opts.style ? opts.style : null;
    var style_version_override = opts.style_version ? opts.style_version : default_style_version;

    // Redis storage keys
    var base_store_key = 'map_style' + '|' + opts.dbname + '|' + opts.table;
    var extended_store_key = me.makeExtendedKey();

    //trigger constructor
    me.init(init_callback);

    return me;
};

module.exports = MMLBuilder;
