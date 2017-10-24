'use strict';

const lib = require('../lib');
const catalog = lib.models.catalog;
const proxyquire = require('proxyquire');
const Promise = require('bluebird');
const errors = require('../lib/errors');
const ServiceInstanceAlreadyExists = errors.ServiceInstanceAlreadyExists;

var used_guid = '4a6e7c34-d97c-4fc0-95e6-7a3bc8030be9';
var free_guid = '87599704-adc9-1acd-0be9-795e6a3bc803';
var boshStub = {
  NetworkSegmentIndex: {
    adjust: function (num) {
      return num;
    },
    findFreeIndex: function () {
      return 2;
    }
  },
  director: {
    getDeploymentNames: function () {
      return Promise.resolve([`service-fabrik-0021-${used_guid}`]);
    },
    getDeploymentNameForInstanceId: function () {
      return Promise.resolve([`service-fabrik-0021-${used_guid}`]);
    }
  }
};

var DirectorManager = proxyquire('../lib/fabrik/DirectorManager', {
  '../bosh': boshStub,
});

describe('fabrik', function () {
  describe('DirectorManager', function () {
    const plan_id = 'bc158c9a-7934-401e-94ab-057082a5073f';
    let manager;

    before(function () {
      manager = new DirectorManager(catalog.getPlan(plan_id));
    });

    describe('#getDeploymentName', function () {
      it('should append guid and network segment index to deployment name', function () {
        expect(manager.plan.id).to.eql(plan_id);
        expect(manager.getDeploymentName(used_guid, '90')).to.eql(`service-fabrik-90-${used_guid}`);
        manager.aquireNetworkSegmentIndex(used_guid)
          .catch(err => expect(err).to.be.instanceof(ServiceInstanceAlreadyExists));
        manager.aquireNetworkSegmentIndex(free_guid).then(index => expect(index).to.eql(2));
      });
    });
    describe('#findNetworkSegmentIndex', function () {
      it('should append guid and network segment index to deployment name', function () {
        manager.findNetworkSegmentIndex(used_guid).then(res => expect(res).to.eql(21));
      });
    });
    describe('#addVmtags', function () {
      it('should append organization guid and space guid to manifest', function () {
        //Test case #1 {When opts has org and space keys}
        var test_manifest = 'properties:\n  a: 1\n  b: 2';
        var opts = {
          organization_guid: 'myorg',
          space_guid: 'myspace'
        };
        var expected_manifest = 'properties:\n  a: 1\n  b: 2\ntags:\n  organization_guid: myorg\n  space_guid: myspace\n';
        expect(manager.addVmtags(test_manifest, opts)).to.eql(expected_manifest);
        //Test case #2 {When opts does not have org and space key}
        opts = {};
        expected_manifest = 'properties:\n  a: 1\n  b: 2\ntags:\n  organization_guid: null\n  space_guid: null\n';
        expect(manager.addVmtags(test_manifest, opts)).to.eql(expected_manifest);
      });
    });

  });
});