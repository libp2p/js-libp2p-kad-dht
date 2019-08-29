/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect
const PeerId = require('peer-id')
const pMap = require('p-map')
const each = require('async/each')
const series = require('async/series')
const range = require('lodash.range')
const random = require('lodash.random')

const RoutingTable = require('../src/routing')
const kadUtils = require('../src/utils')

function createPeerId (n) {
  return pMap(range(n), () => PeerId.create({ bits: 512 }))
}

describe('Routing Table', () => {
  let table

  beforeEach(async function () {
    this.timeout(20 * 1000)

    const id = await PeerId.create({ bits: 512 })
    table = new RoutingTable(id, 20)
  })

  it('add', async function () {
    this.timeout(20 * 1000)

    const ids = await createPeerId(20)

    return new Promise((resolve) => {
      series([
        (cb) => each(range(1000), (n, cb) => {
          table.add(ids[random(ids.length - 1)], cb)
        }, cb),
        (cb) => each(range(20), (n, cb) => {
          const id = ids[random(ids.length - 1)]

          kadUtils.convertPeerId(id, (err, key) => {
            expect(err).to.not.exist()
            expect(table.closestPeers(key, 5).length)
              .to.be.above(0)
            cb()
          })
        }, cb)
      ], resolve)
    })
  })

  it('remove', async function () {
    this.timeout(20 * 1000)

    const peers = await createPeerId(10)
    let k

    return new Promise((resolve) => {
      series([
        (cb) => each(peers, (peer, cbEach) => table.add(peer, cbEach), cb),
        (cb) => {
          const id = peers[2]
          kadUtils.convertPeerId(id, (err, key) => {
            expect(err).to.not.exist()
            k = key
            expect(table.closestPeers(key, 10)).to.have.length(10)
            cb()
          })
        },
        (cb) => table.remove(peers[5], cb),
        (cb) => {
          expect(table.closestPeers(k, 10)).to.have.length(9)
          expect(table.size).to.be.eql(9)
          cb()
        }
      ], resolve)
    })
  })

  it('closestPeer', async function () {
    this.timeout(10 * 1000)

    const peers = await createPeerId(4)

    return new Promise((resolve) => {
      series([
        (cb) => each(peers, (peer, cb) => table.add(peer, cb), cb),
        (cb) => {
          const id = peers[2]
          kadUtils.convertPeerId(id, (err, key) => {
            expect(err).to.not.exist()
            expect(table.closestPeer(key)).to.eql(id)
            cb()
          })
        }
      ], resolve)
    })
  })

  it('closestPeers', async function () {
    this.timeout(20 * 1000)

    const peers = await createPeerId(18)

    return new Promise((resolve) => {
      series([
        (cb) => each(peers, (peer, cb) => table.add(peer, cb), cb),
        (cb) => {
          const id = peers[2]
          kadUtils.convertPeerId(id, (err, key) => {
            expect(err).to.not.exist()
            expect(table.closestPeers(key, 15)).to.have.length(15)
            cb()
          })
        }
      ], resolve)
    })
  })
})
