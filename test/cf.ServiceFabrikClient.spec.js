'use strict';

const _ = require('lodash');
const formatUrl = require('url').format;
const ServiceFabrikClient = require('../lib/cf/ServiceFabrikClient');

const tokenIssuerStub = {
  getAccessToken: () => undefined
};

describe('cf', function () {
  describe('ServiceFabrikClient', function () {
    describe('#initiateBackup', function () {
      /* jshint expr:true */
      const instance_id = '9999-8888-7777-6666';
      const bearer = 'bearer';
      const body = {
        name: 'backup',
        guid: 'a6b39499-8b8b-4e1b-aaec-b2bc11d396e4'
      };
      const response = {
        statusCode: undefined,
        body: body
      };
      const sfClient = new ServiceFabrikClient(tokenIssuerStub);
      let requestSpy, getAccessTokenSpy;

      function buildExpectedRequestArgs(method, path, statusCode, data) {
        const options = {
          method: method,
          url: path,
          auth: {
            bearer: bearer
          },
          json: true
        };
        if (_.isObject(statusCode)) {
          data = statusCode;
          statusCode = undefined;
        }
        if (data) {
          if (_.includes(['GET', 'DELETE'], method)) {
            options.url = formatUrl({
              pathname: options.url,
              query: data
            });
          } else {
            options.body = data;
          }
        }
        _.set(response, 'statusCode', statusCode || 200);
        return [options, response.statusCode];
      }

      beforeEach(function () {
        requestSpy = sinon.stub(sfClient, 'request');
        requestSpy.returns(Promise.resolve(response));
        getAccessTokenSpy = sinon.stub(tokenIssuerStub, 'getAccessToken');
        getAccessTokenSpy.returns(Promise.resolve(bearer));
      });

      afterEach(function () {
        requestSpy.restore();
        getAccessTokenSpy.restore();
      });

      it('should initiate backup successfully', function () {
        const backupOpts = {
          instance_id: instance_id,
          type: 'online'
        };
        const [options, statusCode] = buildExpectedRequestArgs('POST',
          `/api/v1/service_instances/${instance_id}/backup`,
          202,
          _.omit(backupOpts, 'instance_id'));
        return sfClient.startBackup(backupOpts)
          .then(result => {
            expect(getAccessTokenSpy).to.be.calledOnce;
            expect(requestSpy).to.be.calledWithExactly(options, statusCode);
            expect(result).to.eql(body);
          });
      });

      it('should schedule auto-update successfully', function () {
        const payLoad = {
          instance_id: instance_id,
          repeatInterval: '1 1 15 * *'
        };
        const [options, statusCode] = buildExpectedRequestArgs('PUT',
          `/api/v1/service_instances/${instance_id}/schedule_update`,
          201,
          _.omit(payLoad, 'instance_id'));
        return sfClient.scheduleUpdate(payLoad)
          .then(result => {
            expect(getAccessTokenSpy).to.be.calledOnce;
            expect(requestSpy).to.be.calledWithExactly(options, statusCode);
            expect(result).to.eql(body);
          });
      });
    });
  });
});