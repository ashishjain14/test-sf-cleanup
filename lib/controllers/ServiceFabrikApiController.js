'use strict';

const _ = require('lodash');
const assert = require('assert');
const Promise = require('bluebird');
const jwt = require('../jwt');
const docker = require('../docker');
const logger = require('../logger');
const backupStore = require('../iaas').backupStore;
const filename = backupStore.filename;
const errors = require('../errors');
const BaseController = require('./BaseController');
const FabrikStatusPoller = require('../fabrik/FabrikStatusPoller');
const Unauthorized = errors.Unauthorized;
const NotFound = errors.NotFound;
const Forbidden = errors.Forbidden;
const BadRequest = errors.BadRequest;
const UnprocessableEntity = errors.UnprocessableEntity;
const JsonWebTokenError = jwt.JsonWebTokenError;
const ContinueWithNext = errors.ContinueWithNext;
const ScheduleManager = require('../jobs');
const config = require('../config');
const CONST = require('../constants');

const CloudControllerError = {
  NotAuthorized: err => {
    const body = err.error;
    return err.statusCode === 403 && (
      body.code === 10003 || body.error_code === 'CF-NotAuthorized'
    );
  }
};

class ServiceFabrikApiController extends BaseController {
  constructor() {
    super();
  }

  verifyAccessToken(req, res) {
    /* jshint unused:false */
    function handleError(err) {
      throw new Unauthorized(err.message);
    }
    const scopes = [
      'cloud_controller.admin'
    ];
    const requiresAdminScope = this.getConfigPropertyValue('external.api_requires_admin_scope', false);
    switch (_.toUpper(req.method)) {
    case 'GET':
      scopes.push('cloud_controller.admin_read_only');
      if (!requiresAdminScope) {
        scopes.push(
          'cloud_controller.read',
          'cloud_controller_service_permissions.read'
        );
      }
      break;
    default:
      if (!requiresAdminScope) {
        scopes.push('cloud_controller.write');
      }
      break;
    }
    const [scheme, bearer] = _
      .chain(req)
      .get('headers.authorization')
      .split(' ')
      .value();
    return Promise
      .try(() => {
        if (!/^Bearer$/i.test(scheme)) {
          throw new Unauthorized('No access token was found');
        }
        req.auth = {
          bearer: bearer
        };
        return this.uaa.tokenKey();
      })
      .then(tokenKey => jwt.verify(bearer, tokenKey.value))
      .catch(JsonWebTokenError, handleError)
      .tap(token => {
        _.set(req, 'cloudControllerScopes', token.scope);
        if (_
          .chain(token.scope)
          .intersection(scopes)
          .isEmpty()
          .value()) {
          logger.error(`token scope : ${JSON.stringify(token)} - required scope : ${JSON.stringify(scopes)}`);
          throw new Forbidden('Token has insufficient scope');
        }
        req.user = {
          id: token.user_id,
          name: token.user_name,
          email: token.email
        };
      })
      .throw(new ContinueWithNext());
  }

  verifySpacePermission(req, res) {
    /* jshint unused:false */
    const user = req.user;
    const opts = _.pick(req, 'auth');
    const httpMethod = _.toUpper(req.method);
    const insufficientPermissions = `User '${user.name}' has insufficient permissions`;
    let isCloudControllerAdmin = false;
    if (_.get(req, 'cloudControllerScopes').includes('cloud_controller.admin')) {
      isCloudControllerAdmin = true;
    }
    return Promise
      .try(() => {
        const space_guid = req.body.space_guid || req.query.space_guid;
        if (space_guid) {
          this.validateUuid(space_guid, 'Space GUID');
          return space_guid;
        }
        const instanceId = req.params.instance_id;
        this.validateUuid(instanceId, 'Service Instance ID');
        return this.cloudController
          .getServiceInstance(instanceId)
          .tap(body => _.set(req, 'entity.name', body.entity.name))
          .then(body => body.entity.space_guid);
      })
      .tap(space_guid => _.set(req, 'entity.space_guid', space_guid))
      .then(space_guid => {
        if (isCloudControllerAdmin) {
          return;
        }
        return this.cloudController
          .getSpaceDevelopers(space_guid, opts)
          .catchThrow(CloudControllerError.NotAuthorized, new Forbidden(insufficientPermissions));
      })
      .tap(developers => {
        if (isCloudControllerAdmin) {
          logger.info(`User ${user.email} has cloud_controller.admin scope. SpaceDeveloper validation will be skipped`);
          return;
        }
        const isSpaceDeveloper = _
          .chain(developers)
          .findIndex(developer => (developer.metadata.guid === user.id))
          .gte(0)
          .value();
        if (httpMethod !== 'GET' && !isSpaceDeveloper) {
          throw new Forbidden(insufficientPermissions);
        }
        logger.info('space develoopers done');
      })
      .catch(err => {
        logger.warn('Verification of user permissions failed');
        logger.warn(err);
        throw err;
      })
      .throw(new ContinueWithNext());
  }

  getInfo(req, res) {
    return docker
      .getMissingImages()
      .then(missingImages => res
        .status(200)
        .json({
          name: this.serviceBrokerName,
          api_version: this.constructor.version,
          ready: _.isEmpty(missingImages)
        })
      );
  }

  getServiceInstanceState(req, res) {
    req.manager.verifyFeatureSupport('state');
    return req.manager
      .getServiceInstanceState(req.params.instance_id)
      .then(body => res
        .status(200)
        .send(_.pick(body, 'operational', 'details'))
      );
  }

  checkQuota(req, trigger) {
    return Promise
      .try(() => {
        if (trigger === CONST.BACKUP.TRIGGER.SCHEDULED && req.user.name !== config.cf.username) {
          logger.error(`Permission denied. User : ${req.user.name} - cannot trigger scheduled backup`);
          throw new errors.Forbidden('Scheduled backups can only be initiated by the System User');
        } else if (trigger === CONST.BACKUP.TRIGGER.ON_DEMAND) {
          const options = {
            instance_id: req.params.instance_id,
            space_guid: req.entity.space_guid
          };
          return this.listBackupFiles(options)
            .then(backupList => {
              const onDemandBackups = _.filter(backupList, backup => backup.trigger === CONST.BACKUP.TRIGGER.ON_DEMAND);
              if (onDemandBackups.length >= config.backup.max_num_on_demand_backup) {
                throw new errors.Forbidden(`Reached max quota of ${config.backup.max_num_on_demand_backup} ${CONST.BACKUP.TRIGGER.ON_DEMAND} backups`);
              }
              return true;
            });
        }
      });
  }

  startBackup(req, res) {
    req.manager.verifyFeatureSupport('backup');
    const trigger = _.get(req.body, 'trigger', CONST.BACKUP.TRIGGER.ON_DEMAND);
    return Promise
      .try(() => this.checkQuota(req, trigger))
      .then(() => {
        _.set(req.body, 'trigger', trigger);
        const bearer = _
          .chain(req.headers)
          .get('authorization')
          .split(' ')
          .nth(1)
          .value();
        let deploymentName;
        return this.fabrik
          .createOperation('backup', {
            instance_id: req.params.instance_id,
            bearer: bearer,
            arguments: req.body,
            isOperationSync: true,
            username: req.user.name,
            useremail: req.user.email || ''
          })
          .invoke()
          .tap(response => {
            logger.info('backup response ', response);
            const directorManager = req.manager;
            directorManager
              .findNetworkSegmentIndex(req.params.instance_id)
              .then(networkIndex => directorManager.getDeploymentName(req.params.instance_id, networkIndex))
              .tap(name => deploymentName = name)
              .then(deploymentName => directorManager.getLockProperty(deploymentName))
              .then(lockInfo => FabrikStatusPoller.start(lockInfo.instanceInfo, 'backup', req.user))
              .catch(err => {
                logger.error(`Error occurred while setting poller for backup on deployment : ${deploymentName}`, err);
                directorManager.releaseLock(deploymentName)
                  .catch(err => logger.error(`Error occurred while releasing lock of backup on deployment : ${deploymentName}`, err));
              });
          })
          .then(body => res
            .status(202)
            .send(body)
          );
      });
  }

  getLastBackup(req, res) {
    req.manager.verifyFeatureSupport('backup');
    const instance_id = req.params.instance_id;
    const noCache = req.query.no_cache === 'true' ? true : false;
    const space_guid = req.entity.space_guid;
    return req.manager
      .getLastBackup(space_guid, instance_id, noCache)
      .then(result => res
        .status(200)
        .send(_.omit(result, 'secret', 'agent_ip'))
      )
      .catchThrow(NotFound, new NotFound(`No backup found for service instance '${instance_id}'`));
  }

  abortLastBackup(req, res) {
    req.manager.verifyFeatureSupport('backup');
    const instance_id = req.params.instance_id;
    const space_guid = req.entity.space_guid;
    return req.manager
      .abortLastBackup(space_guid, instance_id)
      .then(result => res
        .status(result.state === 'aborting' ? 202 : 200)
        .send({})
      );
  }

  startRestore(req, res) {
    req.manager.verifyFeatureSupport('restore');
    const backup_guid = req.body.backup_guid;
    const space_guid = req.entity.space_guid;
    const plan_id = req.manager.plan.id;
    const bearer = _
      .chain(req.headers)
      .get('authorization')
      .split(' ')
      .nth(1)
      .value();
    return Promise
      .try(() => this.validateUuid(backup_guid, 'Backup GUID'))
      .then(() => this.backupStore
        .getBackupFile({
          backup_guid: backup_guid,
          space_guid: space_guid
        })
      )
      .catchThrow(NotFound, new UnprocessableEntity(`No backup with guid '${backup_guid}' found in this space`))
      .tap(metadata => {
        if (metadata.state !== 'succeeded') {
          throw new UnprocessableEntity(`Can not restore backup '${backup_guid}' due to state '${metadata.state}'`);
        }
        if (metadata.plan_id !== plan_id) {
          throw new UnprocessableEntity(`Backup '${backup_guid}' to restore from is not applicable to the instance's service plan`);
        }
      })
      .then(metadata => this.fabrik
        .createOperation('restore', {
          instance_id: req.params.instance_id,
          bearer: bearer,
          arguments: _.assign({
            backup: _.pick(metadata, 'type', 'secret')
          }, req.body)
        })
        .handle(req, res)
      );
  }

  getLastRestore(req, res) {
    req.manager.verifyFeatureSupport('restore');
    const instance_id = req.params.instance_id;
    const space_guid = req.entity.space_guid;
    return req.manager
      .getLastRestore(space_guid, instance_id)
      .then(result => res
        .status(200)
        .send(result)
      )
      .catchThrow(NotFound, new NotFound(`No restore found for service instance '${instance_id}'`));
  }

  abortLastRestore(req, res) {
    req.manager.verifyFeatureSupport('restore');
    const instance_id = req.params.instance_id;
    const space_guid = req.entity.space_guid;
    return req.manager
      .abortLastRestore(space_guid, instance_id)
      .then(result => res
        .status(result.state === 'aborting' ? 202 : 200)
        .send({})
      );
  }

  listBackups(req, res) {
    const options = _.pick(req.query, 'space_guid', 'service_id', 'plan_id', 'instance_id', 'before', 'after');
    return this.listBackupFiles(options)
      .then(body => res
        .status(200)
        .send(body)
      );
  }

  listBackupFiles(options) {
    function getPredicate(before, after) {
      return function predicate(filenameobject) {
        if (before && !_.lt(filenameobject.started_at, before)) {
          return false;
        }
        if (after && !_.gt(filenameobject.started_at, after)) {
          return false;
        }
        return filenameobject.operation === 'backup';
      };
    }

    return Promise
      .try(() => {
        if (options.instance_id && !options.plan_id) {
          return this.cloudController
            .findServicePlanByInstanceId(options.instance_id)
            .then(resource => {
              options.plan_id = resource.entity.unique_id;
            });
        }
      })
      .then(() => {
        if (options.plan_id && !options.service_id) {
          options.service_id = this.getPlan(options.plan_id).service.id;
        }
        const before = options.before ? filename.isoDate(options.before) : undefined;
        const after = options.after ? filename.isoDate(options.after) : undefined;
        const predicate = getPredicate(before, after);
        return this.backupStore.listBackupFiles(options, predicate);
      })
      .map(data => _.omit(data, 'secret', 'agent_ip', 'logs'));
  }

  listLastOperationOfAllInstances(req, res) {
    return Promise
      .try(() => {
        const options = _.pick(req.query, 'space_guid', 'service_id', 'plan_id');
        switch (req.params.operation) {
        case 'backup':
          return this.backupStore.listLastBackupFiles(options);
        case 'restore':
          return this.backupStore.listLastRestoreFiles(options);
        }
        assert.ok(false, 'List result of last operation is only possible for \'backup\' or \'restore\'');
      })
      .map(data => _.omit(data, 'secret', 'agent_ip', 'logs'))
      .then(body => res
        .status(200)
        .send(body)
      );
  }

  getBackup(req, res) {
    const options = _
      .chain(req.params)
      .pick('backup_guid')
      .assign(req.query)
      .value();
    return this.backupStore
      .getBackupFile(options)
      .then(data => _.omit(data, 'secret', 'agent_ip'))
      .then(body => res
        .status(200)
        .send(body)
      );
  }

  deleteBackup(req, res) {
    const options = {
      space_guid: req.query.space_guid,
      backup_guid: req.params.backup_guid,
      user: req.user
    };
    return this.backupStore
      .deleteBackupFile(options)
      .then(() => res
        .status(200)
        .send({})
      );
  }

  scheduleBackup(req, res) {
    req.manager.verifyFeatureSupport('backup');
    if (_.isEmpty(req.body.repeatInterval) || _.isEmpty(req.body.type)) {
      throw new BadRequest('repeatInterval | type are mandatory');
    }
    const data = _
      .chain(req.body)
      .omit('repeatInterval')
      .set('instance_id', req.params.instance_id)
      .set('trigger', CONST.BACKUP.TRIGGER.SCHEDULED)
      .set('space_guid', req.entity.space_guid)
      .set('plan_id', req.manager.plan.id)
      .set('service_id', req.manager.service.id)
      .value();
    return ScheduleManager
      .schedule(
        req.params.instance_id,
        CONST.JOB.SCHEDULED_BACKUP,
        req.body.repeatInterval,
        data,
        req.user)
      .then(body => res
        .status(201)
        .send(body));
  }

  getBackupSchedule(req, res) {
    req.manager.verifyFeatureSupport('backup');
    return ScheduleManager
      .getSchedule(req.params.instance_id, CONST.JOB.SCHEDULED_BACKUP)
      .then(body => res
        .status(200)
        .send(body));
  }

  cancelScheduledBackup(req, res) {
    req.manager.verifyFeatureSupport('backup');
    if (!_.get(req, 'cloudControllerScopes').includes('cloud_controller.admin')) {
      throw new Forbidden(`Permission denined. Cancelling of backups can only be done by user with cloud_controller.admin scope.`);
    }
    return ScheduleManager
      .cancelSchedule(req.params.instance_id, CONST.JOB.SCHEDULED_BACKUP)
      .then(() => res
        .status(200)
        .send({}));
  }

  scheduleUpdate(req, res) {
    req.manager.isAutoUpdatePossible();
    if (_.isEmpty(req.body.repeatInterval)) {
      throw new BadRequest('repeatInterval is mandatory');
    }
    return Promise
      .try(() => {
        if (req.entity.name) {
          return;
        }
        return this.cloudController
          .getServiceInstance(this.guid)
          .then(instance => _.set(req, 'entity.name', instance.entity.name));
      })
      .then(() => req.manager.findDeploymentNameByInstanceId(req.params.instance_id))
      .then(deploymentName => ({
        instance_id: req.params.instance_id,
        instance_name: req.entity.name,
        deployment_name: deploymentName,
        timeZone: req.body.timeZone
      }))
      .then((jobData) => ScheduleManager
        .schedule(req.params.instance_id,
          CONST.JOB.SERVICE_INSTANCE_UPDATE,
          req.body.repeatInterval,
          jobData,
          req.user))
      .then(body => res
        .status(201)
        .send(body));
  }

  getUpdateSchedule(req, res) {
    req.manager.isAutoUpdatePossible();
    return ScheduleManager
      .getSchedule(req.params.instance_id, CONST.JOB.SERVICE_INSTANCE_UPDATE)
      .then(scheduleInfo => {
        const checkUpdateRequired = _.get(req.query, 'check_update_required');
        logger.info(`Instance Id: ${req.params.instance_id} - check outdated status - ${checkUpdateRequired}`);
        if (checkUpdateRequired) {
          return req.manager
            .findDeploymentNameByInstanceId(req.params.instance_id)
            .then(deploymentName => req.manager.diffManifest(deploymentName))
            .then(result => {
              scheduleInfo.update_required = result.diff && result.diff.length > 0;
              scheduleInfo.update_details = result.diff;
              return scheduleInfo;
            });
        } else {
          return scheduleInfo;
        }
      })
      .then(body => res
        .status(200)
        .send(body));
  }

  static get version() {
    return '1.0';
  }

}

module.exports = ServiceFabrikApiController;