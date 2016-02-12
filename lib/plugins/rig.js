'use strict';

var _ = require('lodash');
var moment = require('moment');
var levels = require('../levels');
var times = require('../times');
var timeago = require('./timeago')();
var openaps = require('./openaps')();

var ALL_STATUS_FIELDS = ['wifi', 'load', 'uptime', 'lastPing'];

function init ( ) {

  var rig = {
    name: 'rig'
    , label: 'Rig'
    , pluginType: 'pill-status'
  };

  rig.getPrefs = function getPrefs (sbx) {

    function cleanList (value) {
      return decodeURIComponent(value || '').toLowerCase().split(' ');
    }

    function isEmpty (list) {
      return _.isEmpty(list) || _.isEmpty(list[0]);
    }

    var fields = cleanList(sbx.extendedSettings.fields);
    fields = isEmpty(fields) ? ['wifi', 'lastPing'] : fields;

    return {
      fields: fields
      , warnLastPing: sbx.extendedSettings.warnLastPing || 5
      , urgentLastPing: sbx.extendedSettings.urgentLastPing || 20
      , warnLoad: sbx.extendedSettings.warnLoad || 2
      , urgentLoad: sbx.extendedSettings.urgentLoad || 5
      , enableAlerts: sbx.extendedSettings.enableAlerts || false
    };
  };

  pump.setProperties = function setProperties (sbx) {
    sbx.offerProperty('rig', function setPump ( ) {

      var prefs = pump.getPrefs(sbx);
      var recentMills = sbx.time - times.mins(prefs.urgentLastPing * 2).msecs;

      var filtered = _.filter(sbx.data.devicestatus, function (status) {
        return ('rig' in status) && sbx.entryMills(status) <= sbx.time && sbx.entryMills(status) >= recentMills;
      });

      var pumpStatus = null;

      _.forEach(filtered, function each (status) {
        status.clockMills = status.pump && status.pump.clock ? moment(status.pump.clock).valueOf() : status.mills;
        if (!pumpStatus || status.clockMills > pumpStatus.clockMills) {
          pumpStatus = status;
        }
      });

      pumpStatus = pumpStatus || { };
      pumpStatus.data = prepareData(pumpStatus, prefs, sbx);

      return pumpStatus;
    });
  };

  pump.checkNotifications = function checkNotifications (sbx) {
    var prefs = pump.getPrefs(sbx);

    if (!prefs.enableAlerts) { return; }

    var data = prepareData(sbx.properties.pump, prefs, sbx);

    if (data.level >= levels.WARN) {
      sbx.notifications.requestNotify({
        level: data.level
        , title: data.title
        , message: data.message
        , pushoverSound: 'echo'
        , plugin: rig
      });
    }
  };

  pump.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.pump;

    var prefs = pump.getPrefs(sbx);
    var result = prepareData(prop, prefs, sbx);

    var values = [ ];
    var info = [ ];

    var selectedFields = prefs.fields;

    _.forEach(ALL_STATUS_FIELDS, function eachField (fieldName) {
      var field = result[fieldName];
      if (field) {
        var selected = _.indexOf(selectedFields, fieldName) > -1;
        if (selected) {
          values.push(field.display);
        } else {
          info.push({label: field.label, value: field.display});
        }
      }
    });

    sbx.pluginBase.updatePillText(pump, {
      value: values.join(' ')
      , info: info
      , label: 'Rig'
      , pillClass: statusClass(result.level)
    });
  };

  return pump;

}

function statusClass (level) {
  var cls = 'current';

  if (level === levels.WARN) {
    cls = 'warn';
  } else if (level === levels.URGENT) {
    cls = 'urgent';
  }

  return cls;
}

function updateLoad (prefs, result) {
  if (result.load) {
    result.load.label = 'Load';
    result.load.display = result.load.value;
    if (result.load.value < prefs.urgentRes) {
      result.load.level = levels.URGENT;
      result.load.message = 'URGENT: High System Load';
    } else if (result.load.value < prefs.warnRes) {
      result.load.level = levels.WARN;
      result.load.message = 'Warning, System Load';
    } else {
      result.load.level = levels.NONE;
    }
  }
}

function updatePing (type, prefs, result) {
  if (result.lastPing) {
    result.lastPing.label = 'Last Ping';
    result.lastPing.display = result.lastPing.value + type;
    var urgent = type === 'v' ? prefs.urgentBattV : prefs.urgentBattP;
    var warn = type === 'v' ? prefs.warnBattV : prefs.warnBattP;

    if (result.lastPing.value < urgent) {
      result.lastPing.level = levels.URGENT;
      result.lastPing.message = 'URGENT: Rig not connected';
    } else if (result.lastPing.value < warn) {
      result.lastPing.level = levels.WARN;
      result.lastPing.message = 'Warning, Rig not connected';
    } else {
      result.lastPing.level = levels.NONE;
    }
  }
}

function buildMessage (result) {
  if (result.level > levels.NONE) {
    var message = [];

    if (result.battery) {
      message.push('Pump Battery: ' + result.battery.display);
    }

    if (result.reservoir) {
      message.push('Pump Reservoir: ' + result.reservoir.display);
    }

    result.message = message.join('\n');
  }
}

function prepareData (prop, prefs, sbx) {
  var pump = (prop && prop.pump) || { };

  var result = {
    level: levels.NONE
    , clock: pump.clock ? { value: moment(pump.clock) } : null
    , reservoir: pump.reservoir ? { value: pump.reservoir } : null
  };

  updateLoad(prefs, result, sbx);
  updatePing(prefs, result);

  result.device = { label: 'Device', display: prop.device };

  result.title = 'Rig Status';
  result.level = levels.NONE;

  //TODO: A new Pump Offline marker?  Something generic?  Use something new instead of a treatment?
  if (openaps.findOfflineMarker(sbx)) {
    console.info('OpenAPS known offline, not checking for alerts');
  } else {
    _.forEach(ALL_STATUS_FIELDS, function eachField(fieldName) {
      var field = result[fieldName];
      if (field && field.level > result.level) {
        result.level = field.level;
        result.title = field.message;
      }
    });
  }

  buildMessage(result);

  return result;
}

function timeFormat (m, sbx) {

  var when;
 if (m) {
    when = formatAgo(m, sbx.time);
  } else {
    when = 'unknown';
  }

  return when;
}

function formatAgo (m, nowMills) {
  var ago = timeago.calcDisplay({mills: m.valueOf()}, nowMills);
  return (ago.value ? ago.value : '') + ago.shortLabel + (ago.shortLabel.length === 1 ? ' ago' : '');
}

module.exports = init;
