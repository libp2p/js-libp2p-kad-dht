/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
chai.use(require('chai-checkmark'))
const expect = chai.expect
const promisify = require('promisify-es6')
const pRetry = require('p-retry')
const pTimes = require('p-times')
const pTimeout = require('p-timeout')
const sinon = require('sinon')
const series = require('async/series')
// const times = require('async/times')
const parallel = require('async/parallel')
// const each = require('async/each')
const waterfall = require('async/waterfall')
const { Record } = require('libp2p-record')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const PeerBook = require('peer-book')
const Switch = require('libp2p-switch')
const TCP = require('libp2p-tcp')
const Mplex = require('libp2p-mplex')
const promiseToCallback = require('promise-to-callback')
const errcode = require('err-code')

const KadDHT = require('../src')
const kadUtils = require('../src/utils')
const c = require('../src/constants')
const Message = require('../src/message')

const createPeerInfo = require('./utils/create-peer-info')
const createValues = require('./utils/create-values')
const TestDHT = require('./utils/test-dht')

// connect two dhts
async function connectNoSync (a, b) {
  const publicPeerId = new PeerId(b.peerInfo.id.id, null, b.peerInfo.id.pubKey)
  const target = new PeerInfo(publicPeerId)
  target.multiaddrs = b.peerInfo.multiaddrs
  await promisify((callback) => a.switch.dial(target, callback))()
}

function find (a, b) {
  return pRetry(async () => {
    let error
    try {
      const match = await promisify((callback) => a.routingTable.find(b.peerInfo.id, callback))()

      if (!match) {
        error = new Error('not found')
      }

      expect(a.peerBook.get(b.peerInfo).multiaddrs.toArray()[0].toString())
        .to.eql(b.peerInfo.multiaddrs.toArray()[0].toString())
    } catch (err) {
      error = err
    }

    if (error) {
      // Interval of 100ms on retry
      await new Promise((resolve) => setTimeout(resolve, 100))
      throw error
    }
  }, { retries: 50 })
}

// connect two dhts and wait for them to have each other
// in their routing table
async function connect (a, b) {
  await connectNoSync(a, b)
  await find(a, b)
  await find(b, a)
}

function bootstrap (dhts) {
  dhts.forEach((dht) => dht.randomWalk._walk(1, 10000))
}

function waitForWellFormedTables (dhts, minPeers, avgPeers, waitTimeout) {
  return pTimeout(pRetry(async () => {
    let totalPeers = 0

    const ready = dhts.map((dht) => {
      const rtlen = dht.routingTable.size
      totalPeers += rtlen
      if (minPeers > 0 && rtlen < minPeers) {
        return false
      }
      const actualAvgPeers = totalPeers / dhts.length
      if (avgPeers > 0 && actualAvgPeers < avgPeers) {
        return false
      }
      return true
    })

    const done = ready.every(Boolean)

    if (!done) {
      // Interval of 200ms on retry
      await new Promise((resolve) => setTimeout(resolve, 200))
      throw new Error('not done yet')
    }
  }, { retries: 50 }), waitTimeout)
}

// Count how many peers are in b but are not in a
// function countDiffPeers (a, b) {
//   const s = new Set()
//   a.forEach((p) => s.add(p.toB58String()))

//   return b.filter((p) => !s.has(p.toB58String())).length
// }

describe('KadDHT', () => {
  let peerInfos
  let values

  before(async function () {
    this.timeout(10 * 1000)

    const res = await Promise.all([
      createPeerInfo(3),
      createValues(20)
    ])

    peerInfos = res[0]
    values = res[1]
  })

  it('create', () => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw, { kBucketSize: 5 })

    expect(dht).to.have.property('peerInfo').eql(peerInfos[0])
    expect(dht).to.have.property('switch').eql(sw)
    expect(dht).to.have.property('kBucketSize', 5)
    expect(dht).to.have.property('routingTable')
  })

  it('create with validators and selectors', () => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()

    const dht = new KadDHT(sw, {
      validators: {
        ipns: {
          func: (key, record) => {}
        }
      },
      selectors: {
        ipns: (key, records) => 0
      }
    })

    expect(dht).to.have.property('peerInfo').eql(peerInfos[0])
    expect(dht).to.have.property('switch').eql(sw)
    expect(dht).to.have.property('routingTable')
    expect(dht.validators).to.have.property('ipns')
    expect(dht.selectors).to.have.property('ipns')
  })

  it('should be able to start and stop', async () => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw)

    sinon.spy(dht.network, 'start')
    sinon.spy(dht.randomWalk, 'start')

    sinon.spy(dht.network, 'stop')
    sinon.spy(dht.randomWalk, 'stop')

    await dht.start()

    expect(dht.network.start.calledOnce).to.equal(true)
    expect(dht.randomWalk.start.calledOnce).to.equal(true)

    await dht.stop()

    expect(dht.network.stop.calledOnce).to.equal(true)
    expect(dht.randomWalk.stop.calledOnce).to.equal(true)
  })

  it('should be able to start with random-walk disabled', async () => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw, { randomWalk: { enabled: false } })

    sinon.spy(dht.network, 'start')
    sinon.spy(dht.randomWalk, 'start')

    sinon.spy(dht.network, 'stop')
    sinon.spy(dht.randomWalk, 'stop')

    await dht.start()

    expect(dht.network.start.calledOnce).to.equal(true)
    expect(dht.randomWalk._runningHandle).to.not.exist()

    await dht.stop()

    expect(dht.network.stop.calledOnce).to.equal(true)
    expect(dht.randomWalk.stop.calledOnce).to.equal(true) // Should be always disabled, as it can be started using the instance
  })

  it('should fail to start when already started', async () => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw, {
      randomWalk: {
        enabled: false
      }
    })

    await dht.start()

    try {
      await dht.start()
    } catch (err) {
      expect(err).to.exist()
      expect(err.code).to.equal('ERR_NETWORK_ALREADY_RUNNING')
      return
    }
    throw new Error('should fail to start when already started')
  })

  it('should fail to stop when was not started', async () => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw, {
      randomWalk: {
        enabled: false
      }
    })

    try {
      await dht.stop()
    } catch (err) {
      expect(err).to.exist()
      expect(err.code).to.equal('ERR_NETWORK_ALREADY_STOPPED')
      return
    }
    throw new Error('should fail to stop when was not started')
  })

  it('put - get', async function () {
    this.timeout(10 * 1000)

    const tdht = new TestDHT()
    const [dhtA, dhtB] = await tdht.spawn(2)

    await connect(dhtA, dhtB)
    await dhtA.put(Buffer.from('/v/hello'), Buffer.from('world'))

    const res = await dhtB.get(Buffer.from('/v/hello'), { timeout: 1000 })
    expect(res).to.eql(Buffer.from('world'))

    return tdht.teardown()
  })

  it('put - should require a minimum number of peers to have successful puts', async function () {
    this.timeout(10 * 1000)
    const tdht = new TestDHT()

    const errCode = 'ERR_NOT_AVAILABLE'
    const error = errcode(new Error('fake error'), errCode)

    const dhts = await tdht.spawn(4)
    const dhtA = dhts[0]
    const dhtB = dhts[1]
    const dhtC = dhts[2]
    const dhtD = dhts[3]
    const stub = sinon.stub(dhtD, '_verifyRecordLocallyAsync').rejects(error)

    await Promise.all([
      connect(dhtA, dhtB),
      connect(dhtA, dhtC),
      connect(dhtA, dhtD)
    ])

    await dhtA.put(Buffer.from('/v/hello'), Buffer.from('world'), { minPeers: 2 })

    const res = await dhtB.get(Buffer.from('/v/hello'), { timeout: 1000 })
    expect(res).to.eql(Buffer.from('world'))

    stub.restore()
    return tdht.teardown()
  })

  it('put - should fail if not enough peers can be written to', async function () {
    this.timeout(10 * 1000)
    const tdht = new TestDHT()

    const errCode = 'ERR_NOT_AVAILABLE'
    const error = errcode(new Error('fake error'), errCode)

    const [dhtA, dhtB, dhtC, dhtD] = await tdht.spawn(4)
    const stub = sinon.stub(dhtD, '_verifyRecordLocallyAsync').rejects(error)
    const stub2 = sinon.stub(dhtC, '_verifyRecordLocallyAsync').rejects(error)

    await Promise.all([
      connect(dhtA, dhtB),
      connect(dhtA, dhtC),
      connect(dhtA, dhtD)
    ])

    try {
      await dhtA.put(Buffer.from('/v/hello'), Buffer.from('world'), { minPeers: 2 })
      await dhtB.get(Buffer.from('/v/hello'), { timeout: 1000 })
    } catch (err) {
      expect(err).to.exist()
      expect(err.code).to.eql('ERR_NOT_ENOUGH_PUT_PEERS')
      stub.restore()
      stub2.restore()
      return tdht.teardown()
    }
    throw new Error('should fail if not enough peers can be written to')
  })

  it('put - should require all peers to be put to successfully if no minPeers specified', async function () {
    this.timeout(10 * 1000)
    const tdht = new TestDHT()

    const errCode = 'ERR_NOT_AVAILABLE'
    const error = errcode(new Error('fake error'), errCode)

    const [dhtA, dhtB, dhtC] = await tdht.spawn(3)
    const stub = sinon.stub(dhtC, '_verifyRecordLocallyAsync').rejects(error)

    await Promise.all([
      connect(dhtA, dhtB),
      connect(dhtA, dhtC)
    ])

    try {
      await dhtA.put(Buffer.from('/v/hello'), Buffer.from('world'), {})
      await dhtB.get(Buffer.from('/v/hello'), { timeout: 1000 })
    } catch (err) {
      expect(err).to.exist()
      expect(err.code).to.eql('ERR_NOT_ENOUGH_PUT_PEERS')
      stub.restore()
      return tdht.teardown()
    }
    throw new Error('should require all peers to be put to successfully if no minPeers specified')
  })

  it('put - get using key with no prefix (no selector available)', async function () {
    this.timeout(10 * 1000)
    const tdht = new TestDHT()

    const [dhtA, dhtB] = await tdht.spawn(2)

    await connect(dhtA, dhtB)
    await dhtA.put(Buffer.from('hello'), Buffer.from('world'))

    const res = await dhtB.get(Buffer.from('hello'), { timeout: 1000 })
    expect(res).to.eql(Buffer.from('world'))

    return tdht.teardown()
  })

  it('put - get using key from provided validator and selector', async function () {
    this.timeout(10 * 1000)
    const tdht = new TestDHT()

    const [dhtA, dhtB] = await tdht.spawn(2, {
      validators: {
        ipns: {
          func: (key, record) => {}
        }
      },
      selectors: {
        ipns: (key, records) => 0
      }
    })

    await connect(dhtA, dhtB)
    await dhtA.put(Buffer.from('/ipns/hello'), Buffer.from('world'))

    const res = await dhtB.get(Buffer.from('/ipns/hello'), { timeout: 1000 })
    expect(res).to.eql(Buffer.from('world'))

    return tdht.teardown()
  })

  it('put - get should fail if unrecognized key prefix in get', async function () {
    this.timeout(10 * 1000)
    const tdht = new TestDHT()

    const [dhtA, dhtB] = await tdht.spawn(2)

    await connect(dhtA, dhtB)

    try {
      await dhtA.put(Buffer.from('/v2/hello'), Buffer.from('world'))
      await dhtB.get(Buffer.from('/v2/hello'), { timeout: 1000 })
    } catch (err) {
      expect(err).to.exist()
      expect(err.code).to.eql('ERR_UNRECOGNIZED_KEY_PREFIX')
      return tdht.teardown()
    }
    throw new Error('should fail if unrecognized key prefix in get')
  })

  it('put - get with update', async function () {
    this.timeout(20 * 1000)
    const tdht = new TestDHT()

    const [dhtA, dhtB] = await tdht.spawn(2)
    const dhtASpy = sinon.spy(dhtA, '_putValueToPeerAsync')

    await dhtA.put(Buffer.from('/v/hello'), Buffer.from('worldA'))
    await dhtB.put(Buffer.from('/v/hello'), Buffer.from('worldB'))

    await connect(dhtA, dhtB)

    const resA = await dhtA.get(Buffer.from('/v/hello'), { timeout: 1000 })
    const resB = await dhtB.get(Buffer.from('/v/hello'), { timeout: 1000 })

    expect(dhtASpy.callCount).to.eql(1)
    expect(dhtASpy.getCall(0).args[2].isEqual(dhtB.peerInfo.id)).to.eql(true) // inform B

    expect(resA).to.eql(Buffer.from('worldA')) // first is selected
    expect(resB).to.eql(Buffer.from('worldA')) // first is selected

    return tdht.teardown()
  })

  it('provides', async function () {
    this.timeout(20 * 1000)

    const tdht = new TestDHT()
    const dhts = await tdht.spawn(4)

    const addrs = dhts.map((d) => d.peerInfo.multiaddrs.toArray()[0])
    const ids = dhts.map((d) => d.peerInfo.id)
    const idsB58 = ids.map(id => id.toB58String())
    sinon.spy(dhts[3].network, 'sendMessage')

    await Promise.all([
      connect(dhts[0], dhts[1]),
      connect(dhts[1], dhts[2]),
      connect(dhts[2], dhts[3])
    ])

    await Promise.all(values.map((v) => dhts[3].provide(v.cid)))

    // Expect an ADD_PROVIDER message to be sent to each peer for each value
    const fn = dhts[3].network.sendMessage
    const valuesBuffs = values.map(v => v.cid.buffer)
    const calls = fn.getCalls().map(c => c.args)
    for (const [peerId, msg] of calls) {
      expect(idsB58).includes(peerId.toB58String())
      expect(msg.type).equals(Message.TYPES.ADD_PROVIDER)
      expect(valuesBuffs).includes(msg.key)
      expect(msg.providerPeers.length).equals(1)
      expect(msg.providerPeers[0].id.toB58String()).equals(idsB58[3])
    }

    // Expect each DHT to find the provider of each value
    let n = 0
    const res = await Promise.all(values.map((v) => {
      n = (n + 1) % 3

      return dhts[n].findProviders(v.cid, { timeout: 5000 })
    }))

    for (const provs of res) {
      expect(provs).to.have.length(1)
      expect(provs[0].id.id).to.be.eql(ids[3].id)
      expect(provs[0].multiaddrs.toArray()[0].toString()).to.equal(addrs[3].toString())
    }
    return tdht.teardown()
  })

  it('find providers', async function () {
    this.timeout(20 * 1000)

    const val = values[0]
    const tdht = new TestDHT()
    const dhts = await tdht.spawn(3)

    await Promise.all([
      connect(dhts[0], dhts[1]),
      connect(dhts[1], dhts[2])
    ])

    await Promise.all(dhts.map((dht) => dht.provide(val.cid)))

    // find providers find all the 3 providers
    let res = await dhts[0].findProviders(val.cid, {})
    expect(res).to.exist()
    expect(res).to.have.length(3)

    // find providers limited to a maxium of 2 providers
    res = await dhts[0].findProviders(val.cid, { maxNumProviders: 2 })
    expect(res).to.exist()
    expect(res).to.have.length(2)

    return tdht.teardown()
  })

  it('random-walk', async function () {
    this.timeout(20 * 1000)

    const nDHTs = 20
    const tdht = new TestDHT()

    // random walk disabled for a manual usage
    const dhts = await tdht.spawn(nDHTs)

    // ring connect
    await pTimes(nDHTs, (i) => connect(dhts[i], dhts[(i + 1) % nDHTs]))

    bootstrap(dhts)
    await waitForWellFormedTables(dhts, 7, 0, 20 * 1000)

    return tdht.teardown()
  })

  it('layered get', async function () {
    this.timeout(40 * 1000)

    const nDHTs = 4
    const tdht = new TestDHT()

    const dhts = await tdht.spawn(nDHTs)

    await Promise.all([
      connect(dhts[0], dhts[1]),
      connect(dhts[1], dhts[2]),
      connect(dhts[2], dhts[3])
    ])

    await dhts[3].put(Buffer.from('/v/hello'), Buffer.from('world'))

    const res = await dhts[0].get(Buffer.from('/v/hello'), { timeout: 1000 })
    expect(res).to.eql(Buffer.from('world'))

    return tdht.teardown()
  })

  it('findPeer', async function () {
    this.timeout(40 * 1000)

    const nDHTs = 4
    const tdht = new TestDHT()
    const dhts = await tdht.spawn(nDHTs)
    const ids = dhts.map((d) => d.peerInfo.id)

    await Promise.all([
      connect(dhts[0], dhts[1]),
      connect(dhts[1], dhts[2]),
      connect(dhts[2], dhts[3])
    ])

    const res = await dhts[0].findPeer(ids[3], { timeout: 1000 })
    expect(res.id.isEqual(ids[3])).to.eql(true)

    return tdht.teardown()
  })

  it('connect by id to with address in the peerbook ', async function () {
    this.timeout(20 * 1000)

    const nDHTs = 2
    const tdht = new TestDHT()
    const [dhtA, dhtB] = await tdht.spawn(nDHTs)

    const peerA = dhtA.peerInfo
    const peerB = dhtB.peerInfo
    dhtA.peerBook.put(peerB)
    dhtB.peerBook.put(peerA)

    return new Promise((resolve) => {
      parallel([
        (cb) => dhtA.switch.dial(peerB.id, cb),
        (cb) => dhtB.switch.dial(peerA.id, cb)
      ], async (err) => {
        expect(err).to.not.exist()
        await tdht.teardown()

        resolve()
      })
    })
  })

  // it('find peer query', function (done) {
  //   this.timeout(40 * 1000)

  //   // Create 101 nodes
  //   const nDHTs = 100
  //   const tdht = new TestDHT()

  //   tdht.spawn(nDHTs, (err, dhts) => {
  //     expect(err).to.not.exist()

  //     const dhtsById = new Map(dhts.map((d) => [d.peerInfo.id, d]))
  //     const ids = [...dhtsById.keys()]

  //     // The origin node for the FIND_PEER query
  //     const guy = dhts[0]

  //     // The key
  //     const val = Buffer.from('foobar')
  //     // The key as a DHT key
  //     let rtval

  //     series([
  //       // Hash the key into the DHT's key format
  //       (cb) => kadUtils.convertBuffer(val, (err, dhtKey) => {
  //         expect(err).to.not.exist()
  //         rtval = dhtKey
  //         cb()
  //       }),
  //       // Make connections between nodes close to each other
  //       (cb) => kadUtils.sortClosestPeers(ids, rtval, (err, sorted) => {
  //         expect(err).to.not.exist()

  //         const conns = []
  //         const maxRightIndex = sorted.length - 1
  //         for (let i = 0; i < sorted.length; i++) {
  //           // Connect to 5 nodes on either side (10 in total)
  //           for (const distance of [1, 3, 11, 31, 63]) {
  //             let rightIndex = i + distance
  //             if (rightIndex > maxRightIndex) {
  //               rightIndex = maxRightIndex * 2 - (rightIndex + 1)
  //             }
  //             let leftIndex = i - distance
  //             if (leftIndex < 0) {
  //               leftIndex = 1 - leftIndex
  //             }
  //             conns.push([sorted[leftIndex], sorted[rightIndex]])
  //           }
  //         }

  //         each(conns, (conn, _cb) => connect(dhtsById.get(conn[0]), dhtsById.get(conn[1]), _cb), cb)
  //       }),
  //       (cb) => {
  //         // Get the alpha (3) closest peers to the key from the origin's
  //         // routing table
  //         const rtablePeers = guy.routingTable.closestPeers(rtval, c.ALPHA)
  //         expect(rtablePeers).to.have.length(c.ALPHA)

  //         // The set of peers used to initiate the query (the closest alpha
  //         // peers to the key that the origin knows about)
  //         const rtableSet = {}
  //         rtablePeers.forEach((p) => {
  //           rtableSet[p.toB58String()] = true
  //         })

  //         const guyIndex = ids.findIndex(i => i.id.equals(guy.peerInfo.id.id))
  //         const otherIds = ids.slice(0, guyIndex).concat(ids.slice(guyIndex + 1))
  //         series([
  //           // Make the query
  //           (cb) => guy.getClosestPeers(val, cb),
  //           // Find the closest connected peers to the key
  //           (cb) => kadUtils.sortClosestPeers(otherIds, rtval, cb)
  //         ], (err, res) => {
  //           expect(err).to.not.exist()

  //           // Query response
  //           const out = res[0]

  //           // All connected peers in order of distance from key
  //           const actualClosest = res[1]

  //           // Expect that the response includes nodes that are were not
  //           // already in the origin's routing table (ie it went out to
  //           // the network to find closer peers)
  //           expect(out.filter((p) => !rtableSet[p.toB58String()]))
  //             .to.not.be.empty()

  //           // Expect that there were kValue peers found
  //           expect(out).to.have.length(c.K)

  //           // The expected closest kValue peers to the key
  //           const exp = actualClosest.slice(0, c.K)

  //           // Expect the kValue peers found to be the kValue closest connected peers
  //           // to the key
  //           expect(countDiffPeers(exp, out)).to.eql(0)

  //           cb()
  //         })
  //       }
  //     ], (err) => {
  //       expect(err).to.not.exist()
  //       tdht.teardown(done)
  //     })
  //   })
  // })

  it('getClosestPeers', async function () {
    this.timeout(40 * 1000)

    const nDHTs = 30
    const tdht = new TestDHT()

    const dhts = await tdht.spawn(nDHTs)

    // ring connect
    await pTimes(nDHTs, (i) => connect(dhts[i], dhts[(i + 1) % nDHTs]))

    const res = await dhts[1].getClosestPeers(Buffer.from('foo'))
    expect(res).to.have.length(c.K)

    return tdht.teardown()
  })

  describe('getPublicKey', () => {
    it('already known', async function () {
      this.timeout(20 * 1000)

      const nDHTs = 2
      const tdht = new TestDHT()
      const dhts = await tdht.spawn(nDHTs)
      const ids = dhts.map((d) => d.peerInfo.id)

      dhts[0].peerBook.put(dhts[1].peerInfo)

      const key = await dhts[0].getPublicKey(ids[1])
      expect(key).to.eql(dhts[1].peerInfo.id.pubKey)

      return tdht.teardown()
    })

    it('connected node', async function () {
      this.timeout(30 * 1000)

      const nDHTs = 2
      const tdht = new TestDHT()
      const dhts = await tdht.spawn(nDHTs)
      const ids = dhts.map((d) => d.peerInfo.id)

      await connect(dhts[0], dhts[1])

      // remove the pub key to be sure it is fetched
      const p = dhts[0].peerBook.get(ids[1])
      p.id._pubKey = null
      dhts[0].peerBook.put(p, true)

      const key = await dhts[0].getPublicKey(ids[1])
      expect(key.equals(dhts[1].peerInfo.id.pubKey)).to.eql(true)

      return tdht.teardown()
    })
  })

  it('_nearestPeersToQuery', (done) => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw)

    dht.peerBook.put(peerInfos[1])
    series([
      (cb) => dht._add(peerInfos[1], cb),
      (cb) => dht._nearestPeersToQuery({ key: 'hello' }, cb)
    ], (err, res) => {
      expect(err).to.not.exist()
      expect(res[1]).to.be.eql([peerInfos[1]])
      done()
    })
  })

  it('_betterPeersToQuery', (done) => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw)

    dht.peerBook.put(peerInfos[1])
    dht.peerBook.put(peerInfos[2])

    series([
      (cb) => dht._add(peerInfos[1], cb),
      (cb) => dht._add(peerInfos[2], cb),
      (cb) => dht._betterPeersToQuery({ key: 'hello' }, peerInfos[1], cb)
    ], (err, res) => {
      expect(err).to.not.exist()
      expect(res[2]).to.be.eql([peerInfos[2]])
      done()
    })
  })

  describe('_checkLocalDatastore', () => {
    it('allow a peer record from store if recent', (done) => {
      const sw = new Switch(peerInfos[0], new PeerBook())
      sw.transport.add('tcp', new TCP())
      sw.connection.addStreamMuxer(Mplex)
      sw.connection.reuse()
      const dht = new KadDHT(sw)

      const record = new Record(
        Buffer.from('hello'),
        Buffer.from('world')
      )
      record.timeReceived = new Date()

      waterfall([
        (cb) => dht._putLocal(record.key, record.serialize(), cb),
        (cb) => dht._checkLocalDatastore(record.key, cb)
      ], (err, rec) => {
        expect(err).to.not.exist()
        expect(rec).to.exist('Record should not have expired')
        expect(rec.value.toString()).to.equal(record.value.toString())
        done()
      })
    })

    it('delete entries received from peers that have expired', (done) => {
      const sw = new Switch(peerInfos[0], new PeerBook())
      sw.transport.add('tcp', new TCP())
      sw.connection.addStreamMuxer(Mplex)
      sw.connection.reuse()
      const dht = new KadDHT(sw)

      const record = new Record(
        Buffer.from('hello'),
        Buffer.from('world')
      )
      const received = new Date()
      received.setDate(received.getDate() - 2)

      record.timeReceived = received

      waterfall([
        (cb) => dht._putLocal(record.key, record.serialize(), cb),
        (cb) => {
          promiseToCallback(dht.datastore.get(kadUtils.bufferToKey(record.key)))(cb)
        },
        (lookup, cb) => {
          expect(lookup).to.exist('Record should be in the local datastore')
          cb()
        },
        (cb) => dht._checkLocalDatastore(record.key, cb)
      ], (err, rec) => {
        expect(err).to.not.exist()
        expect(rec).to.not.exist('Record should have expired')

        promiseToCallback(dht.datastore.get(kadUtils.bufferToKey(record.key)))((err, lookup) => {
          expect(err).to.exist('Should throw error for not existing')
          expect(lookup).to.not.exist('Record should be removed from datastore')
          done()
        })
      })
    })
  })

  describe('_verifyRecordLocally', () => {
    it('valid record', (done) => {
      const sw = new Switch(peerInfos[0], new PeerBook())
      sw.transport.add('tcp', new TCP())
      sw.connection.addStreamMuxer(Mplex)
      sw.connection.reuse()
      const dht = new KadDHT(sw)

      dht.peerBook.put(peerInfos[1])

      const record = new Record(
        Buffer.from('hello'),
        Buffer.from('world')
      )
      const enc = record.serialize()

      dht._verifyRecordLocally(Record.deserialize(enc), done)
    })
  })

  // describe('getMany', () => {
  //   it('getMany with nvals=1 goes out to swarm if there is no local value', (done) => {
  //     const sw = new Switch(peerInfos[0], new PeerBook())
  //     sw.transport.add('tcp', new TCP())
  //     sw.connection.addStreamMuxer(Mplex)
  //     sw.connection.reuse()
  //     const dht = new KadDHT(sw)
  //     dht.start((err) => {
  //       expect(err).to.not.exist()

  //       const key = Buffer.from('/v/hello')
  //       const value = Buffer.from('world')
  //       const rec = new Record(key, value)

  //       const stubs = [
  //         // Simulate returning a peer id to query
  //         sinon.stub(dht.routingTable, 'closestPeers').returns([peerInfos[1].id]),
  //         // Simulate going out to the network and returning the record
  //         sinon.stub(dht, '_getValueOrPeersAsync').callsFake(async () => ({ record: rec })) // eslint-disable-line require-await
  //       ]

  //       dht.getMany(key, 1, (err, res) => {
  //         expect(err).to.not.exist()
  //         expect(res.length).to.eql(1)
  //         expect(res[0].val).to.eql(value)

  //         for (const stub of stubs) {
  //           stub.restore()
  //         }
  //         done()
  //       })
  //     })
  //   })
  // })

  describe('errors', () => {
    it('get many should fail if only has one peer', async function () {
      this.timeout(20 * 1000)

      const nDHTs = 1
      const tdht = new TestDHT()

      const dhts = await tdht.spawn(nDHTs)

      try {
        await dhts[0].getMany(Buffer.from('/v/hello'), 5, {})
      } catch (err) {
        expect(err).to.exist()
        expect(err.code).to.be.eql('ERR_NO_PEERS_IN_ROUTING_TABLE')

        return tdht.teardown()
      }
      throw new Error('get many should fail if only has one peer')
    })

    //   it('get should handle correctly an unexpected error', function (done) {
    //     this.timeout(20 * 1000)

    //     const errCode = 'ERR_INVALID_RECORD_FAKE'
    //     const error = errcode(new Error('fake error'), errCode)

    //     const nDHTs = 2
    //     const tdht = new TestDHT()

    //     tdht.spawn(nDHTs, (err, dhts) => {
    //       expect(err).to.not.exist()

    //       const dhtA = dhts[0]
    //       const dhtB = dhts[1]
    //       const stub = sinon.stub(dhtA, '_getValueOrPeersAsync').rejects(error)

    //       waterfall([
    //         (cb) => connect(dhtA, dhtB, cb),
    //         (cb) => dhtA.get(Buffer.from('/v/hello'), { timeout: 1000 }, cb)
    //       ], (err) => {
    //         expect(err).to.exist()
    //         expect(err.code).to.be.eql(errCode)

    //         stub.restore()
    //         tdht.teardown(done)
    //       })
    //     })
  })

  //   it('get should handle correctly an invalid record error and return not found', function (done) {
  //     this.timeout(20 * 1000)

  //     const error = errcode(new Error('invalid record error'), 'ERR_INVALID_RECORD')

  //     const nDHTs = 2
  //     const tdht = new TestDHT()

  //     tdht.spawn(nDHTs, (err, dhts) => {
  //       expect(err).to.not.exist()

  //       const dhtA = dhts[0]
  //       const dhtB = dhts[1]
  //       const stub = sinon.stub(dhtA, '_getValueOrPeersAsync').rejects(error)

  //       waterfall([
  //         (cb) => connect(dhtA, dhtB, cb),
  //         (cb) => dhtA.get(Buffer.from('/v/hello'), cb)
  //       ], (err) => {
  //         expect(err).to.exist()
  //         expect(err.code).to.be.eql('ERR_NOT_FOUND')

  //         stub.restore()
  //         tdht.teardown(done)
  //       })
  //     })
  //   })

  //   it('findPeer should fail if no closest peers available', function (done) {
  //     this.timeout(40 * 1000)

  //     const nDHTs = 4
  //     const tdht = new TestDHT()

  //     tdht.spawn(nDHTs, (err, dhts) => {
  //       expect(err).to.not.exist()

  //       const ids = dhts.map((d) => d.peerInfo.id)

  //       waterfall([
  //         (cb) => connect(dhts[0], dhts[1], cb),
  //         (cb) => connect(dhts[1], dhts[2], cb),
  //         (cb) => connect(dhts[2], dhts[3], cb)
  //       ], (err) => {
  //         expect(err).to.not.exist()
  //         const stub = sinon.stub(dhts[0].routingTable, 'closestPeers').returns([])

  //         dhts[0].findPeer(ids[3], { timeout: 1000 }, (err) => {
  //           expect(err).to.exist()
  //           expect(err.code).to.eql('ERR_LOOKUP_FAILED')
  //           stub.restore()
  //           tdht.teardown(done)
  //         })
  //       })
  //     })
  //   })
  // })

  // describe('multiple nodes', () => {
  //   const n = 8
  //   let tdht
  //   let dhts

  //   // spawn nodes
  //   before(function (done) {
  //     this.timeout(10 * 1000)

  //     tdht = new TestDHT()
  //     tdht.spawn(n, (err, res) => {
  //       expect(err).to.not.exist()
  //       dhts = res

  //       done()
  //     })
  //   })

  //   // connect nodes
  //   before(function (done) {
  //     // all nodes except the last one
  //     const range = Array.from(Array(n - 1).keys())

  //     // connect the last one with the others one by one
  //     parallel(range.map((i) =>
  //       (cb) => connect(dhts[n - 1], dhts[i], cb)), done)
  //   })

  //   after(function (done) {
  //     this.timeout(10 * 1000)

  //     tdht.teardown(done)
  //   })

  //   it('put to "bootstrap" node and get with the others', function (done) {
  //     this.timeout(10 * 1000)

  //     dhts[7].put(Buffer.from('/v/hello0'), Buffer.from('world'), (err) => {
  //       expect(err).to.not.exist()

  //       parallel([
  //         (cb) => dhts[0].get(Buffer.from('/v/hello0'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[1].get(Buffer.from('/v/hello0'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[2].get(Buffer.from('/v/hello0'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[3].get(Buffer.from('/v/hello0'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[4].get(Buffer.from('/v/hello0'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[5].get(Buffer.from('/v/hello0'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[6].get(Buffer.from('/v/hello0'), { maxTimeout: 1000 }, cb)
  //       ], (err, res) => {
  //         expect(err).to.not.exist()
  //         expect(res[0]).to.eql(Buffer.from('world'))
  //         expect(res[1]).to.eql(Buffer.from('world'))
  //         expect(res[2]).to.eql(Buffer.from('world'))
  //         expect(res[3]).to.eql(Buffer.from('world'))
  //         expect(res[4]).to.eql(Buffer.from('world'))
  //         expect(res[5]).to.eql(Buffer.from('world'))
  //         expect(res[6]).to.eql(Buffer.from('world'))
  //         done()
  //       })
  //     })
  //   })

  //   it('put to a node and get with the others', function (done) {
  //     this.timeout(10 * 1000)

  //     dhts[1].put(Buffer.from('/v/hello1'), Buffer.from('world'), (err) => {
  //       expect(err).to.not.exist()

  //       parallel([
  //         (cb) => dhts[0].get(Buffer.from('/v/hello1'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[2].get(Buffer.from('/v/hello1'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[3].get(Buffer.from('/v/hello1'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[4].get(Buffer.from('/v/hello1'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[5].get(Buffer.from('/v/hello1'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[6].get(Buffer.from('/v/hello1'), { maxTimeout: 1000 }, cb),
  //         (cb) => dhts[7].get(Buffer.from('/v/hello1'), { maxTimeout: 1000 }, cb)
  //       ], (err, res) => {
  //         expect(err).to.not.exist()
  //         expect(res[0]).to.eql(Buffer.from('world'))
  //         expect(res[1]).to.eql(Buffer.from('world'))
  //         expect(res[2]).to.eql(Buffer.from('world'))
  //         expect(res[3]).to.eql(Buffer.from('world'))
  //         expect(res[4]).to.eql(Buffer.from('world'))
  //         expect(res[5]).to.eql(Buffer.from('world'))
  //         expect(res[6]).to.eql(Buffer.from('world'))
  //         done()
  //       })
  //     })
  //   })

  //   it('put to several nodes in series with different values and get the last one in a subset of them', function (done) {
  //     this.timeout(20 * 1000)
  //     const key = Buffer.from('/v/hallo')
  //     const result = Buffer.from('world4')

  //     series([
  //       (cb) => dhts[0].put(key, Buffer.from('world0'), cb),
  //       (cb) => dhts[1].put(key, Buffer.from('world1'), cb),
  //       (cb) => dhts[2].put(key, Buffer.from('world2'), cb),
  //       (cb) => dhts[3].put(key, Buffer.from('world3'), cb),
  //       (cb) => dhts[4].put(key, Buffer.from('world4'), cb)
  //     ], (err) => {
  //       expect(err).to.not.exist()

  //       parallel([
  //         (cb) => dhts[3].get(key, { maxTimeout: 2000 }, cb),
  //         (cb) => dhts[4].get(key, { maxTimeout: 2000 }, cb),
  //         (cb) => dhts[5].get(key, { maxTimeout: 2000 }, cb),
  //         (cb) => dhts[6].get(key, { maxTimeout: 2000 }, cb)
  //       ], (err, res) => {
  //         expect(err).to.not.exist()
  //         expect(res[0]).to.eql(result)
  //         expect(res[1]).to.eql(result)
  //         expect(res[2]).to.eql(result)
  //         expect(res[3]).to.eql(result)
  //         done()
  //       })
  //     })
  //   })
  // })
})
