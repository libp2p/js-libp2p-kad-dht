/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect

const LimitedPeerSet = require('../src/limited-peer-set')

const createPeerInfo = require('./utils/create-peer-info')

describe('LimitedPeerList', () => {
  let peers

  before(async function () {
    this.timeout(10 * 1000)

    peers = await createPeerInfo(5)
  })

  it('basics', () => {
    const l = new LimitedPeerSet(4)

    expect(l.add(peers[0])).to.eql(true)
    expect(l.add(peers[0])).to.eql(false)
    expect(l.add(peers[1])).to.eql(true)
    expect(l.add(peers[2])).to.eql(true)
    expect(l.add(peers[3])).to.eql(true)
    expect(l.add(peers[4])).to.eql(false)

    expect(l.size).to.eql(4)
    expect(l.toArray()).to.eql([peers[0], peers[1], peers[2], peers[3]])
  })
})
