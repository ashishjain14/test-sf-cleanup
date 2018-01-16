'use strict';

const Header = require('../lib/bosh/manifest/Header');

describe('bosh', () => {
  describe('manifest', () => {
    describe('Header', () => {
      let header = new Header({
        name: 1,
        releases: 3,
        stemcells: [{
          alias: 'ubuntu-trusty',
          name: 'bosh-openstack-kvm-ubuntu-trusty-go_agent',
          version: 'latest'
        }],
        tags: {
          space_guid: '1234',
          organization_guid: '4567'
        }
      });

      describe('#toString', () => {
        it('returns a YAML object as string', () => {
          let expectedString = 'name: 1\nreleases: 3\nstemcells:\n  - alias: ubuntu-trusty\n    name: bosh-openstack-kvm-ubuntu-trusty-go_agent\n    version: latest\ntags:\n  space_guid: \'1234\'\n  organization_guid: \'4567\'\n';

          expect(header.toString()).to.eql(expectedString);
        });
      });
    });
  });
});