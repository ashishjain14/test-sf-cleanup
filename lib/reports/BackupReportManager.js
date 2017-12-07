'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const moment = require('moment-timezone');
const Repository = require('../db').Repository;
const CONST = require('../constants');
const config = require('../config');

class BackupReportManager {
  static getInstanceBackupSummary(instanceId, startTime, endTime) {
    return Promise
      .all([
        this.getBackupTriggerRecord(instanceId, startTime, endTime),
        this.getBackupResult(instanceId, startTime, endTime),
        this.getLastRunDetail(instanceId),
        this.getJobDetails(instanceId)
      ])
      .spread((triggeredBackups, resultBackups, lastRunDetail, jobDetail) => {
        const instanceRecord = {};
        const noBackupDays = [];
        //iterator to first entry of the day
        let startIndex = 0;
        let threeConsecutiveBackupFailureCount = 0;
        let currentDay = new Date(startTime);
        let lastFailDay;
        let secondlastFailDay;
        let backupSuccessCount = 0;
        if (jobDetail) {
          if (startTime < moment.utc(jobDetail.createdAt).startOf('day').toDate()) {
            currentDay = moment.utc(jobDetail.createdAt).startOf('day').toDate();
          }
          _.assign(instanceRecord, {
            instanceCreateTime: jobDetail.createdAt
          });
        } else {
          currentDay = new Date(endTime);
        }
        if (lastRunDetail && (endTime > lastRunDetail.createdAt)) {
          _.assign(instanceRecord, {
            instanceDeleteTime: lastRunDetail.createdAt
          });
          endTime = lastRunDetail.createdAt;
        }
        //iterate through list of days and for each day count successful backups
        for (; currentDay < endTime; currentDay = moment(currentDay).add(1, 'days').toDate()) {
          let day_end = endTime < moment(currentDay).add(1, 'days').toDate() ? endTime : moment(currentDay).add(1, 'days').toDate();
          //iterator to last entry on the day
          let endIndex = startIndex;
          while (
            endIndex < resultBackups.length &&
            resultBackups[endIndex].metric === config.monitoring.success_metric &&
            resultBackups[endIndex].createdAt < day_end
          ) {
            endIndex++;
          }
          backupSuccessCount += (endIndex - startIndex);
          if (startIndex === endIndex) {
            noBackupDays.push(currentDay);
            if (
              (secondlastFailDay && lastFailDay) &&
              (secondlastFailDay.valueOf() === moment(lastFailDay).subtract(1, 'days').toDate().valueOf()) &&
              (lastFailDay.valueOf() === moment(currentDay).subtract(1, 'days').toDate().valueOf())
            ) {
              threeConsecutiveBackupFailureCount++;
            }
            secondlastFailDay = lastFailDay;
            lastFailDay = currentDay;
          }
          startIndex = endIndex;
        }
        const summary = {
          noBackupDays: noBackupDays,
          backupsTriggerred: triggeredBackups.length,
          backupsSucceeded: backupSuccessCount,
          backupFailed: (resultBackups.length - backupSuccessCount),
          failedBackupGuids: resultBackups.slice(backupSuccessCount),
          failedBackups3daysInARow: threeConsecutiveBackupFailureCount
        };
        _.assign(instanceRecord, summary);
        return instanceRecord;
      });
  }

  static getLastRunDetail(instanceId) {
    const criteria = {
      type: CONST.JOB.SCHEDULED_BACKUP,
      'data.instance_id': instanceId,
      'response.delete_backup_status.instance_deleted': true
    };
    return Repository.findOne(CONST.DB_MODEL.JOB_RUN_DETAIL, criteria);
  }

  static getJobDetails(instanceId) {
    const criteria = {
      type: CONST.JOB.SCHEDULED_BACKUP,
      'data.instance_id': instanceId
    };
    return Repository.findOne(CONST.DB_MODEL.JOB, criteria);
  }

  static getInstancesWithBackupScheduled(startTime, endTime) {
    function getInstancesWithBackupScheduled(instanceList, offset, modelName, searchCriteria, paginateOpts) {
      if (offset < 0) {
        return Promise.resolve();
      }
      if (!paginateOpts) {
        paginateOpts = {
          records: config.mongodb.record_max_fetch_count,
          offset: offset
        };
      } else {
        _.chain(paginateOpts)
          .set('offset', offset)
          .value();
      }
      return Repository.search(modelName, searchCriteria, paginateOpts)
        .then((result) => {
          instanceList.push.apply(instanceList, _.map(result.list, 'data'));
          return getInstancesWithBackupScheduled(instanceList, result.nextOffset, modelName, searchCriteria, paginateOpts);
        });
    }
    const criteria = {
      searchBy: {
        type: CONST.JOB.SCHEDULED_BACKUP
      },
      projection: {
        'data.instance_id': 1,
        'data.service_name': 1,
        'data.instance_name': 1,
        'data.plan_id': 1,
        'data.service_plan_name': 1,
        'data.space_guid': 1,
        'data.space_name': 1,
        'data.organization_guid': 1,
        'data.organization_name': 1
      }
    };
    if (endTime) {
      _.assign(criteria.searchBy, {
        createdAt: {
          $lt: endTime
        }
      });
    }
    const paginateOpts = {
      records: config.mongodb.record_max_fetch_count,
      offset: 0
    };
    const result = [];
    return getInstancesWithBackupScheduled(result, 0, CONST.DB_MODEL.JOB, criteria, paginateOpts)
      .then(() => result);
  }

  //startTime and endTime are Date objects
  //Aggregated documents of all the triggered backup entries
  static getBackupTriggerRecord(instanceId, startTime, endTime) {
    const match = {
      eventName: 'create_backup',
      metric: config.monitoring.inprogress_metric,
      instanceId: instanceId,
      createdAt: {
        '$gte': startTime,
        '$lt': endTime
      },
      'response.guid': {
        '$exists': true,
        '$ne': null
      }
    };
    const group = {
      _id: '$response.guid',
      createdAt: {
        $first: '$createdAt'
      }
    };
    const sort = {
      createdAt: CONST.REPORT_BACKUP.SORT.ASC
    };
    const aggregateCriteria = [{
      $match: match
    }, {
      $group: group
    }, {
      $sort: sort
    }];
    return Repository.aggregate(CONST.DB_MODEL.EVENT_DETAIL, aggregateCriteria);
  }

  //Aggregated documents of all the succeeded and failed backup entries, sorted first by metric then by create time
  static getBackupResult(instanceId, startTime, endTime) {
    const match = {
      eventName: 'create_backup',
      instanceId: instanceId,
      metric: {
        '$ne': config.monitoring.inprogress_metric
      },
      createdAt: {
        '$gte': startTime,
        '$lt': endTime
      },
      'request.backup_guid': {
        '$exists': true,
        '$ne': null
      }
    };
    const group = {
      _id: '$request.backup_guid',
      metric: {
        $first: '$metric'
      },
      createdAt: {
        $first: '$createdAt'
      }
    };
    const sort = {
      metric: CONST.REPORT_BACKUP.SORT.ASC,
      createdAt: CONST.REPORT_BACKUP.SORT.ASC
    };
    const aggregateCriteria = [{
      $match: match
    }, {
      $group: group
    }, {
      $sort: sort
    }];
    return Repository.aggregate(CONST.DB_MODEL.EVENT_DETAIL, aggregateCriteria);
  }
}

module.exports = BackupReportManager;