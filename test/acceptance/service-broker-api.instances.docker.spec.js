'use strict';

const _ = require('lodash');
const parseUrl = require('url').parse;
const lib = require('../../lib');
const app = require('../support/apps').internal;
const catalog = lib.models.catalog;
const docker = lib.docker;
const config = lib.config;
const fabrik = lib.fabrik;

describe('service-broker-api', function () {
  describe('instances', function () {
    /* jshint expr:true */
    describe('docker', function () {
      const base_url = '/cf/v2';
      const api_version = '2.9';
      const service_id = '24731fb8-7b84-4f57-914f-c3d55d793dd4';
      const plan_id = '466c5078-df6e-427d-8fb2-c76af50c0f56';
      const plan = catalog.getPlan(plan_id);
      const organization_guid = 'b8cbbac8-6a20-42bc-b7db-47c205fccf9a';
      const space_guid = 'e7c0a437-7585-4d75-addf-aa4d45b49f3a';
      const instance_id = 'b3e03cb5-29cc-4fcf-9900-023cf149c554';
      const binding_id = 'd336b15c-37d6-4249-b3c7-430d5153a0d8';
      const app_guid = 'app-guid';
      const parameters = {
        foo: 'bar'
      };
      const accepts_incomplete = true;
      const usedPorts = [38782, 44635];
      const docker_url = parseUrl(config.docker.url);
      const protocol = config.external.protocol;
      const host = config.external.host;
      const username = 'user';
      const password = 'secret';

      before(function () {
        _.unset(fabrik.DockerManager, plan_id);
        mocks.docker.inspectImage();
        mocks.docker.getAllContainers(usedPorts);
        return mocks.setup([
          fabrik.DockerManager.load(plan),
          docker.updatePortRegistry()
        ]);
      });

      afterEach(function () {
        mocks.reset();
      });

      describe('#updatePortRegistry', function () {
        it('returns all used tcp ports', function () {
          expect(docker.portRegistry.getPorts('tcp')).to.eql([33331].concat(usedPorts));
        });
      });

      describe('#provision', function () {
        it('returns 201 Created', function () {
          mocks.cloudController.createSecurityGroup(instance_id);
          mocks.docker.createContainer(instance_id);
          mocks.docker.startContainer();
          mocks.docker.inspectContainer();
          return chai.request(app)
            .put(`${base_url}/service_instances/${instance_id}`)
            .set('X-Broker-API-Version', api_version)
            .auth(config.username, config.password)
            .send({
              service_id: service_id,
              plan_id: plan_id,
              organization_guid: organization_guid,
              space_guid: space_guid,
              parameters: parameters,
              accepts_incomplete: accepts_incomplete
            })
            .then(res => {
              expect(res).to.have.status(201);
              expect(res.body).to.eql({
                dashboard_url: `${protocol}://${host}/manage/instances/${service_id}/${plan_id}/${instance_id}`
              });
              mocks.verify();
            });
        });
      });

      describe('#update', function () {
        it('returns 200 OK', function () {
          mocks.docker.inspectContainer(instance_id);
          mocks.docker.deleteContainer();
          mocks.docker.createContainer(instance_id);
          mocks.docker.startContainer();
          mocks.docker.inspectContainer();
          return chai.request(app)
            .patch(`${base_url}/service_instances/${instance_id}`)
            .send({
              service_id: service_id,
              plan_id: plan_id,
              parameters: parameters,
              previous_values: {
                plan_id: plan_id,
                service_id: service_id,
                organization_id: organization_guid,
                space_id: space_guid
              },
              accepts_incomplete: accepts_incomplete
            })
            .set('X-Broker-API-Version', api_version)
            .auth(config.username, config.password)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });
      });

      describe('#deprovision', function () {
        it('returns 200 OK', function () {
          mocks.cloudController.findSecurityGroupByName(instance_id);
          mocks.cloudController.deleteSecurityGroup(instance_id);
          mocks.docker.deleteContainer(instance_id);
          mocks.docker.deleteVolumes(instance_id);
          return chai.request(app)
            .delete(`${base_url}/service_instances/${instance_id}`)
            .query({
              service_id: service_id,
              plan_id: plan_id,
              accepts_incomplete: accepts_incomplete
            })
            .set('X-Broker-API-Version', api_version)
            .auth(config.username, config.password)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });
      });

      describe('#bind', function () {
        it('returns 201 Created', function () {
          mocks.docker.inspectContainer(instance_id);
          return chai.request(app)
            .put(`${base_url}/service_instances/${instance_id}/service_bindings/${binding_id}`)
            .set('X-Broker-API-Version', api_version)
            .auth(config.username, config.password)
            .send({
              service_id: service_id,
              plan_id: plan_id,
              app_guid: app_guid,
              bind_resource: {
                app_guid: app_guid
              }
            })
            .then(res => {
              expect(res).to.have.status(201);
              expect(res.body).to.eql({
                credentials: {
                  hostname: docker_url.hostname,
                  username: username,
                  password: password,
                  ports: {
                    '12345/tcp': 12345
                  },
                  uri: `http://${username}:${password}@${docker_url.hostname}`
                }
              });
              mocks.verify();
            });
        });
      });

      describe('#unbind', function () {
        it('returns 200 OK', function () {
          return chai.request(app)
            .delete(`${base_url}/service_instances/${instance_id}/service_bindings/${binding_id}`)
            .query({
              service_id: service_id,
              plan_id: plan_id
            })
            .set('X-Broker-API-Version', api_version)
            .auth(config.username, config.password)
            .catch(err => err.response)
            .then(res => {
              expect(res).to.have.status(200);
              expect(res.body).to.eql({});
              mocks.verify();
            });
        });
      });
    });
  });
});