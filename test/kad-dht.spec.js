/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
chai.use(require('chai-checkmark'))
const expect = chai.expect
const sinon = require('sinon')
const random = require('lodash.random')
const Record = require('libp2p-record').Record
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const PeerBook = require('peer-book')
const Switch = require('libp2p-switch')
const TCP = require('libp2p-tcp')
const Mplex = require('libp2p-mplex')
const { collect } = require('streaming-iterables')

const errcode = require('err-code')

const KadDHT = require('../src')
const kadUtils = require('../src/utils')
const c = require('../src/constants')

const createPeerInfo = require('./utils/create-peer-info')
const createValues = require('./utils/create-values')
const TestDHT = require('./utils/test-dht')

// connect two dhts
function connectNoSync (a, b) {
  const publicPeerId = new PeerId(b.peerInfo.id.id, null, b.peerInfo.id.pubKey)
  const target = new PeerInfo(publicPeerId)
  target.multiaddrs = b.peerInfo.multiaddrs
  return new Promise(resolve => a.switch.dial(target, resolve))
}

function find (a, b) {
  return kadUtils.retry({ times: 50, interval: 100 }, async () => {
    const match = await a.routingTable.find(b.peerInfo.id)
    if (!match) {
      throw new Error('not found')
    }

    expect(a.peerBook.get(b.peerInfo).multiaddrs.toArray()[0].toString())
      .to.eql(b.peerInfo.multiaddrs.toArray()[0].toString())
  })
}

function promiseTimesMap (n, fn) {
  return Promise.all([...new Array(n)].map((a, i) => fn(i)))
}

async function withDHTs (n, fn) {
  const tdht = new TestDHT()
  const dhts = await tdht.spawn(n)
  await fn(dhts)
  await tdht.teardown()
}

// connect two dhts and wait for them to have each other
// in their routing table
async function connect (a, b) {
  await connectNoSync(a, b)
  await find(a, b)
  await find(b, a)
}

function bootstrap (dhts) {
  for (const dht of dhts) {
    dht.randomWalk.start(1, 1000) // don't need to know when it finishes
  }
}

function waitForWellFormedTables (dhts, minPeers, avgPeers, waitTimeout) {
  return kadUtils.promiseTimeout(kadUtils.retry({ times: 50, interval: 200 }, () => {
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
      throw new Error('not done yet')
    }
  }), waitTimeout)
}

function countDiffPeers (a, b) {
  const s = new Set()
  a.forEach((p) => s.add(p.toB58String()))

  return b.filter((p) => !s.has(p.toB58String())).length
}

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

  it('should be able to start and stop', async function () {
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

  it('should be able to start with random-walk disabled', async function () {
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
    expect(dht.randomWalk.start.calledOnce).to.equal(false)

    await dht.stop()

    expect(dht.network.stop.calledOnce).to.equal(true)
    // Should always be disabled, as it can be started using the instance
    expect(dht.randomWalk.stop.calledOnce).to.equal(true)
  })

  it('should fail to start when already started', async function () {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw, { enabledDiscovery: false })

    await dht.start()
    try {
      await dht.start()
    } catch (err) {
      return
    }
    expect.fail('did not throw error')
  })

  it('should fail to stop when was not started', async function () {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw, { enabledDiscovery: false })

    try {
      await dht.stop()
    } catch (err) {
      return
    }
    expect.fail('did not throw error')
  })

  it('should emit a peer event when a peer is connected', function () {
    this.timeout(10 * 1000)
    return withDHTs(2, async ([dhtA, dhtB]) => {
      dhtA.on('peer', (peerInfo) => {
        expect(peerInfo).to.exist().mark()
      })

      dhtB.on('peer', (peerInfo) => {
        expect(peerInfo).to.exist().mark()
      })

      connect(dhtA, dhtB)

      return new Promise((resolve) => expect(2).checks(resolve))
    })
  })

  it('put - get many', function () {
    this.timeout(10 * 1000)
    return withDHTs(3, async ([dhtA, dhtB, dhtC]) => {
      await connect(dhtA, dhtC)
      await connect(dhtB, dhtC)

      await dhtA.put(Buffer.from('/v/hello'), Buffer.from('world'))
      await dhtB.put(Buffer.from('/v/hello'), Buffer.from('world'))

      for (let count = 1; count <= 3; count++) {
        let i = 0
        const it = dhtC.getMany(Buffer.from('/v/hello'), count, { timeout: 1000 })
        for await (const res of it) {
          expect(res.val).to.eql(Buffer.from('world'))
          i++
        }
        expect(i).to.eql(count)
      }
    })
  })

  it('put - get', function () {
    this.timeout(10 * 1000)
    return withDHTs(2, async ([dhtA, dhtB]) => {
      await connect(dhtA, dhtB)

      await dhtA.put(Buffer.from('/v/hello'), Buffer.from('world'))

      const res = await dhtB.get(Buffer.from('/v/hello'), { timeout: 1000 })

      expect(res).to.eql(Buffer.from('world'))
    })
  })

  it('put - should require a minimum number of peers to have successful puts', function () {
    this.timeout(10 * 1000)

    const errCode = 'ERR_NOT_AVAILABLE'
    const error = errcode(new Error('fake error'), errCode)

    return withDHTs(4, async (dhts) => {
      const dhtA = dhts[0]
      const dhtB = dhts[1]
      const dhtC = dhts[2]
      const dhtD = dhts[3]
      const stub = sinon.stub(dhtD, '_verifyRecordLocally').callsArgWithAsync(1, error)

      await connect(dhtA, dhtB)
      await connect(dhtA, dhtC)
      await connect(dhtA, dhtD)
      await dhtA.put(Buffer.from('/v/hello'), Buffer.from('world'), { minPeers: 2 })
      const res = await dhtB.get(Buffer.from('/v/hello'), { timeout: 1000 })
      expect(res).to.eql(Buffer.from('world'))

      stub.restore()
    })
  })

  it('put - should fail if not enough peers can be written to', function (done) {
    this.timeout(10 * 1000)

    const errCode = 'ERR_NOT_AVAILABLE'
    const error = errcode(new Error('fake error'), errCode)

    return withDHTs(4, async (dhts) => {
      const dhtA = dhts[0]
      const dhtB = dhts[1]
      const dhtC = dhts[2]
      const dhtD = dhts[3]
      const stub = sinon.stub(dhtD, '_verifyRecordLocally').callsArgWithAsync(1, error)
      const stub2 = sinon.stub(dhtC, '_verifyRecordLocally').callsArgWithAsync(1, error)

      await connect(dhtA, dhtB)
      await connect(dhtA, dhtC)
      await connect(dhtA, dhtD)
      try {
        await dhtA.put(Buffer.from('/v/hello'), Buffer.from('world'), { minPeers: 2 })
      } catch (err) {
        expect(err.code).to.eql('ERR_NOT_ENOUGH_PUT_PEERS')
        stub.restore()
        stub2.restore()
        return
      }
      expect.fail('Did not throw error')
    })
  })

  it('put - should require all peers to be put to successfully if no minPeers specified', function (done) {
    this.timeout(10 * 1000)

    const errCode = 'ERR_NOT_AVAILABLE'
    const error = errcode(new Error('fake error'), errCode)

    return withDHTs(3, async ([dhtA, dhtB, dhtC]) => {
      const stub = sinon.stub(dhtC, '_verifyRecordLocally').callsArgWithAsync(1, error)

      await connect(dhtA, dhtB)
      await connect(dhtA, dhtC)
      try {
        await dhtA.put(Buffer.from('/v/hello'), Buffer.from('world'), { minPeers: 2 })
        // (cb) => dhtB.get(Buffer.from('/v/hello'), { timeout: 1000 }, cb),
        // (res, cb) => {
        //   expect(res).to.eql(Buffer.from('world'))
        //   cb()
        // }
      } catch (err) {
        expect(err.code).to.eql('ERR_NOT_ENOUGH_PUT_PEERS')
        stub.restore()
        return
      }
      expect.fail('Did not throw error')
    })
  })

  it('put - get using key with no prefix (no selector available)', function () {
    this.timeout(10 * 1000)
    return withDHTs(2, async ([dhtA, dhtB]) => {
      await connect(dhtA, dhtB)

      await dhtA.put(Buffer.from('hello'), Buffer.from('world'))

      const res = await dhtB.get(Buffer.from('hello'), { timeout: 1000 })

      expect(res).to.eql(Buffer.from('world'))
    })
  })

  it('put - get using key from provided validator and selector', async function () {
    this.timeout(10 * 1000)
    const tdht = new TestDHT()

    const dhts = await tdht.spawn(2, {
      validators: {
        ipns: {
          func: (key, record) => {}
        }
      },
      selectors: {
        ipns: (key, records) => 0
      }
    })

    const dhtA = dhts[0]
    const dhtB = dhts[1]

    await connect(dhtA, dhtB)

    await dhtA.put(Buffer.from('/ipns/hello'), Buffer.from('world'))

    const res = await dhtB.get(Buffer.from('/ipns/hello'), { timeout: 1000 })

    expect(res).to.eql(Buffer.from('world'))

    await tdht.teardown()
  })

  it('put - get should fail if unrecognized key prefix in get', function () {
    this.timeout(10 * 1000)
    return withDHTs(2, async ([dhtA, dhtB]) => {
      await connect(dhtA, dhtB)

      await dhtA.put(Buffer.from('/v2/hello'), Buffer.from('world'))

      try {
        await dhtB.get(Buffer.from('/v2/hello'), { timeout: 1000 })
      } catch (err) {
        expect(err.code).to.eql('ERR_UNRECOGNIZED_KEY_PREFIX')
        return
      }
      expect.fail('did not throw error')
    })
  })

  it('put - get with update', function () {
    this.timeout(20 * 1000)
    return withDHTs(2, async ([dhtA, dhtB]) => {
      const dhtASpy = sinon.spy(dhtA, '_putValueToPeer')

      await dhtA.put(Buffer.from('/v/hello'), Buffer.from('worldA'))
      await dhtB.put(Buffer.from('/v/hello'), Buffer.from('worldB'))
      await connect(dhtA, dhtB)

      const results = []
      results.push(await dhtA.get(Buffer.from('/v/hello'), { timeout: 1000 }))
      results.push(await dhtB.get(Buffer.from('/v/hello'), { timeout: 1000 }))

      for (const res of results) {
        expect(res).to.eql(Buffer.from('worldA')) // first is selected
      }

      expect(dhtASpy.callCount).to.eql(1)
      expect(dhtASpy.getCall(0).args[2].isEqual(dhtB.peerInfo.id)).to.eql(true) // inform B
    })
  })

  it('provides', function () {
    this.timeout(20 * 1000)

    return withDHTs(4, async (dhts) => {
      const addrs = dhts.map((d) => d.peerInfo.multiaddrs.toArray()[0])
      const ids = dhts.map((d) => d.peerInfo.id)

      await connect(dhts[0], dhts[1])
      await connect(dhts[1], dhts[2])
      await connect(dhts[2], dhts[3])
      await Promise.all(values.map((v) => dhts[3].provide(v.cid)))

      let n = 0
      await Promise.all(values.map(async (v) => {
        n = (n + 1) % 3
        const provs = await collect(dhts[n].findProviders(v.cid, { timeout: 5000 }))

        expect(provs).to.have.length(1)
        expect(provs[0].id.id).to.be.eql(ids[3].id)
        expect(
          provs[0].multiaddrs.toArray()[0].toString()
        ).to.equal(
          addrs[3].toString()
        )
      }))
    })
  })

  it('find providers', function () {
    this.timeout(20 * 1000)
    return withDHTs(3, async (dhts) => {
      const val = values[0]

      await connect(dhts[0], dhts[1])
      await connect(dhts[1], dhts[2])
      await Promise.all(dhts.map((dht) => dht.provide(val.cid)))

      const res1 = await collect(dhts[0].findProviders(val.cid, {}))
      const res2 = await collect(dhts[0].findProviders(val.cid, { maxNumProviders: 2 }))

      // find providers find all the 3 providers
      expect(res1).to.exist()
      expect(res1).to.have.length(3)

      // find providers limited to a maxium of 2 providers
      expect(res2).to.exist()
      expect(res2).to.have.length(2)
    })
  })

  it('random-walk', async function () {
    this.timeout(40 * 1000)

    const nDHTs = 20
    const tdht = new TestDHT()

    // random walk disabled for a manual usage
    const dhts = await tdht.spawn(nDHTs, { randomWalk: { enabled: false } })

    // ring connect
    await promiseTimesMap(nDHTs, (i) => {
      return connect(dhts[i], dhts[(i + 1) % nDHTs])
    })

    await bootstrap(dhts)

    await waitForWellFormedTables(dhts, 7, 0, 20 * 1000)

    await tdht.teardown()
  })

  it('layered get', function () {
    this.timeout(40 * 1000)

    return withDHTs(4, async (dhts) => {
      await connect(dhts[0], dhts[1])
      await connect(dhts[1], dhts[2])
      await connect(dhts[2], dhts[3])

      await dhts[3].put(
        Buffer.from('/v/hello'),
        Buffer.from('world')
      )

      const res = await dhts[0].get(Buffer.from('/v/hello'), { timeout: 1000 })
      expect(res).to.eql(Buffer.from('world'))
    })
  })

  it('findPeer', async function () {
    this.timeout(40 * 1000)

    return withDHTs(4, async (dhts) => {
      const ids = dhts.map((d) => d.peerInfo.id)

      await connect(dhts[0], dhts[1])
      await connect(dhts[1], dhts[2])
      await connect(dhts[2], dhts[3])

      const res = await dhts[0].findPeer(ids[3], { timeout: 1000 })

      expect(res.id.isEqual(ids[3])).to.eql(true)
    })
  })

  it('connect by id to peer with address in the peerbook ', function () {
    this.timeout(20 * 1000)

    return withDHTs(3, async ([dhtA, dhtB]) => {
      const peerA = dhtA.peerInfo
      const peerB = dhtB.peerInfo
      dhtA.peerBook.put(peerB)
      dhtB.peerBook.put(peerA)

      return Promise.all([
        new Promise((resolve) => dhtA.switch.dial(peerB.id, resolve)),
        new Promise((resolve) => dhtB.switch.dial(peerA.id, resolve))
      ])
    })
  })

  it('find peer query', function () {
    this.timeout(40 * 1000)

    return withDHTs(101, async (dhts) => {
      const ids = dhts.map((d) => d.peerInfo.id)

      const guy = dhts[0]
      const others = dhts.slice(1)
      const val = Buffer.from('foobar')
      const connected = {} // indexes in others that are reachable from guy

      await promiseTimesMap(20, (i) => {
        return promiseTimesMap(16, (j) => {
          const t = 20 + random(79)
          connected[t] = true
          return connect(others[i], others[t])
        })
      })

      await promiseTimesMap(20, (i) => {
        connected[i] = true
        return connect(guy, others[i])
      })

      const rtval = await kadUtils.convertBuffer(val)

      const rtablePeers = guy.routingTable.closestPeers(rtval, c.ALPHA)
      expect(rtablePeers).to.have.length(3)

      const netPeers = guy.peerBook.getAllArray().filter((p) => p.isConnected())
      expect(netPeers).to.have.length(20)

      const rtableSet = {}
      rtablePeers.forEach((p) => {
        rtableSet[p.toB58String()] = true
      })

      const connectedIds = ids.slice(1).filter((id, i) => connected[i])

      const out = await guy.getClosestPeers(val)
      const actualClosest = await kadUtils.sortClosestPeers(connectedIds, rtval)

      expect(out.filter((p) => !rtableSet[p.toB58String()]))
        .to.not.be.empty()

      expect(out).to.have.length(20)
      const exp = actualClosest.slice(0, 20)

      const got = await kadUtils.sortClosestPeers(out, rtval)

      expect(countDiffPeers(exp, got)).to.eql(0)
    })
  })

  it('getClosestPeers', function () {
    this.timeout(40 * 1000)

    return withDHTs(30, async (dhts) => {
      await promiseTimesMap(dhts.length, (i) => {
        return connect(dhts[i], dhts[(i + 1) % dhts.length])
      })

      const res = await dhts[1].getClosestPeers(Buffer.from('foo'))

      expect(res).to.have.length(c.K)
    })
  })

  describe('getPublicKey', () => {
    it('already known', function () {
      this.timeout(20 * 1000)

      return withDHTs(2, async (dhts) => {
        const ids = dhts.map((d) => d.peerInfo.id)

        dhts[0].peerBook.put(dhts[1].peerInfo)
        const key = await dhts[0].getPublicKey(ids[1])

        expect(key).to.eql(dhts[1].peerInfo.id.pubKey)
      })
    })

    it('connected node', function () {
      this.timeout(30 * 1000)

      return withDHTs(2, async (dhts) => {
        const ids = dhts.map((d) => d.peerInfo.id)

        await connect(dhts[0], dhts[1])

        // remove the pub key to be sure it is fetched
        const p = dhts[0].peerBook.get(ids[1])
        p.id._pubKey = null
        dhts[0].peerBook.put(p, true)
        const key = await dhts[0].getPublicKey(ids[1])

        expect(key.equals(dhts[1].peerInfo.id.pubKey)).to.eql(true)
      })
    })
  })

  it('_nearestPeersToQuery', async () => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw)

    dht.peerBook.put(peerInfos[1])

    await dht._add(peerInfos[1])
    const res = await dht._nearestPeersToQuery({ key: 'hello' })

    expect(res).to.be.eql([peerInfos[1]])
  })

  it('_betterPeersToQuery', async () => {
    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    const dht = new KadDHT(sw)

    dht.peerBook.put(peerInfos[1])
    dht.peerBook.put(peerInfos[2])

    await dht._add(peerInfos[1])
    await dht._add(peerInfos[2])

    const res = await dht._betterPeersToQuery({ key: 'hello' }, peerInfos[1])

    expect(res).to.be.eql([peerInfos[2]])
  })

  describe('_checkLocalDatastore', () => {
    it('allow a peer record from store if recent', async () => {
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

      await dht._putLocal(record.key, record.serialize())
      const rec = await dht._checkLocalDatastore(record.key)

      expect(rec).to.exist('Record should not have expired')
      expect(rec.value.toString()).to.equal(record.value.toString())
    })

    it('delete entries received from peers that have expired', async () => {
      const sw = new Switch(peerInfos[0], new PeerBook())
      sw.transport.add('tcp', new TCP())
      sw.connection.addStreamMuxer(Mplex)
      sw.connection.reuse()
      const dht = new KadDHT(sw)

      const record = new Record(
        Buffer.from('hello'),
        Buffer.from('world')
      )
      let received = new Date()
      received.setDate(received.getDate() - 2)

      record.timeReceived = received

      await dht._putLocal(record.key, record.serialize())
      const lookup = await dht.datastore.get(kadUtils.bufferToKey(record.key))

      expect(lookup).to.exist('Record should be in the local datastore')

      const rec = await dht._checkLocalDatastore(record.key)

      expect(rec).to.not.exist('Record should have expired')

      try {
        await dht.datastore.get(kadUtils.bufferToKey(record.key))
      } catch (err) {
        return
      }
      expect.fail('Should throw error for not existing')
    })
  })

  describe('_verifyRecordLocally', () => {
    it('valid record', async () => {
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

      const enc = await record.serialize()
      await dht._verifyRecordLocally(Record.deserialize(enc))
    })
  })

  describe('errors', () => {
    it('get many should fail if only has one peer', function () {
      this.timeout(20 * 1000)

      return withDHTs(1, async (dhts) => {
        try {
          await collect(dhts[0].getMany('/v/hello', 5))
        } catch (err) {
          expect(err.code).to.be.eql('ERR_NO_PEERS_IN_ROUTING_TABLE')
          return
        }
        expect.fail('did not throw error')
      })
    })

    it('get should handle correctly an unexpected error', function () {
      this.timeout(20 * 1000)

      const errCode = 'ERR_INVALID_RECORD_FAKE'
      const error = errcode(new Error('fake error'), errCode)

      return withDHTs(2, async ([dhtA, dhtB]) => {
        const stub = sinon.stub(dhtA, '_getValueOrPeers').throws(error)

        await connect(dhtA, dhtB)

        try {
          await dhtA.get(Buffer.from('/v/hello'), { timeout: 1000 })
        } catch (err) {
          expect(err).to.exist()
          expect(err.code).to.be.eql(errCode)

          stub.restore()
          return
        }
        expect.fail('did not throw error')
      })
    })

    it('get should handle correctly an invalid record error and return not found', function () {
      this.timeout(20 * 1000)

      const error = errcode(new Error('invalid record error'), 'ERR_INVALID_RECORD')

      return withDHTs(2, async ([dhtA, dhtB]) => {
        const stub = sinon.stub(dhtA, '_getValueOrPeers').throws(error)

        await connect(dhtA, dhtB)

        try {
          await dhtA.get(Buffer.from('/v/hello'))
        } catch (err) {
          expect(err).to.exist()
          expect(err.code).to.be.eql('ERR_NOT_FOUND')

          stub.restore()
          return
        }
        expect.fail('did not throw error')
      })
    })

    it('findPeer should fail if no closest peers available', async function () {
      this.timeout(40 * 1000)

      return withDHTs(4, async (dhts) => {
        const ids = dhts.map((d) => d.peerInfo.id)

        await connect(dhts[0], dhts[1])
        await connect(dhts[1], dhts[2])
        await connect(dhts[2], dhts[3])

        const stub = sinon.stub(dhts[0].routingTable, 'closestPeers').returns([])

        try {
          await dhts[0].findPeer(ids[3], { timeout: 1000 })
        } catch (err) {
          expect(err).to.exist()
          expect(err.code).to.eql('ERR_LOOKUP_FAILED')
          stub.restore()
          return
        }
        expect.fail('did not throw error')
      })
    })
  })
})
