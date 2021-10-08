/* eslint-env mocha */
'use strict'

const { expect } = require('aegir/utils/chai')
const sinon = require('sinon')
const { Multiaddr } = require('multiaddr')
const { Record } = require('libp2p-record')
const errcode = require('err-code')
const { equals: uint8ArrayEquals } = require('uint8arrays/equals')
const { fromString: uint8ArrayFromString } = require('uint8arrays/from-string')
const { toString: uint8ArrayToString } = require('uint8arrays/to-string')

const all = require('async-iterator-all')
const pMapSeries = require('p-map-series')
const pEachSeries = require('p-each-series')
const delay = require('delay')

const kadUtils = require('../src/utils')
const c = require('../src/constants')
const { Message, MESSAGE_TYPE_LOOKUP } = require('../src/message')

const createPeerId = require('./utils/create-peer-id')
const createValues = require('./utils/create-values')
const TestDHT = require('./utils/test-dht')
const { countDiffPeers } = require('./utils')
const { sortClosestPeers } = require('./utils/sort-closest-peers')

describe('KadDHT', () => {
  let peerIds
  let values
  let tdht

  beforeEach(() => {
    tdht = new TestDHT()
  })

  afterEach(() => {
    tdht.teardown()
  })

  before(async function () {
    this.timeout(10 * 1000)

    const res = await Promise.all([
      createPeerId(3),
      createValues(20)
    ])

    peerIds = res[0]
    values = res[1]
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('create', () => {
    it('simple', async () => {
      const [dht] = await tdht.spawn(1, {
        kBucketSize: 5
      })

      expect(dht).to.have.property('put')
      expect(dht).to.have.property('get')
      expect(dht).to.have.property('getMany')
      expect(dht).to.have.property('removeLocal')
      expect(dht).to.have.property('provide')
      expect(dht).to.have.property('findProviders')
      expect(dht).to.have.property('findPeer')
      expect(dht).to.have.property('getClosestPeers')
      expect(dht).to.have.property('getPublicKey')
      expect(dht).to.have.property('enableServerMode')
      expect(dht).to.have.property('enableClientMode')
    })
  })

  describe('start and stop', () => {
    it('simple with defaults', async () => {
      const [dht] = await tdht.spawn(1, null, false)

      sinon.spy(dht._network, 'start')

      sinon.spy(dht._network, 'stop')

      dht.start()
      expect(dht._network.start.calledOnce).to.equal(true)

      dht.stop()
      expect(dht._network.stop.calledOnce).to.equal(true)
    })

    it('server mode', async () => {
      // Currently off by default
      const [dht] = await tdht.spawn(1, null, false)

      dht._libp2p.handle = sinon.stub()

      dht.start()
      expect(dht._libp2p.handle.callCount).to.equal(0)

      dht.enableServerMode()
      expect(dht._libp2p.handle.callCount).to.equal(1)

      dht.stop()
    })

    it('client mode', async () => {
      // Currently on by default
      const [dht] = await tdht.spawn(1, { clientMode: true }, false)

      dht._libp2p.handle = sinon.stub()

      dht.start()
      dht.stop()
      expect(dht._libp2p.handle.callCount).to.equal(0)
    })

    it('should not fail when already started', async () => {
      const [dht] = await tdht.spawn(1, null, false)

      dht.start()
      dht.start()
      dht.start()

      dht.stop()
    })

    it('should not fail to stop when was not started', async () => {
      const [dht] = await tdht.spawn(1, null, false)

      dht.stop()
    })
  })

  describe('content fetching', () => {
    it('put - get same node', async function () {
      this.timeout(10 * 1000)

      const key = uint8ArrayFromString('/v/hello')
      const value = uint8ArrayFromString('world')

      const [dht] = await tdht.spawn(1, {
        clientMode: false
      })

      // Exchange data through the dht
      await dht.put(key, value)

      const res = await dht.get(key)
      expect(res).to.eql(value)
    })

    it('put - removeLocal', async function () {
      this.timeout(10 * 1000)

      const key = uint8ArrayFromString('/v/hello')
      const value = uint8ArrayFromString('world')

      const [dht] = await tdht.spawn(1, {
        clientMode: false
      })

      await dht.put(key, value)

      const res = await dht.get(key)
      expect(res).to.eql(value)

      // remove from the local datastore
      await dht.removeLocal(key)

      await expect(dht._datastore.get(key)).to.eventually.be.rejected().with.property('code', 'ERR_NOT_FOUND')
    })

    it('put - get', async function () {
      this.timeout(10 * 1000)

      const key = uint8ArrayFromString('/v/hello')
      const value = uint8ArrayFromString('world')

      const [dhtA, dhtB] = await tdht.spawn(2, {
        clientMode: false
      })

      // Connect nodes
      await tdht.connect(dhtA, dhtB)

      // Exchange data through the dht
      await dhtA.put(key, value)

      const res = await dhtB.get(uint8ArrayFromString('/v/hello'))
      expect(res).to.eql(value)
    })

    it('put - should require a minimum number of peers to have successful puts', async function () {
      this.timeout(10 * 1000)

      const errCode = 'ERR_NOT_AVAILABLE'
      const error = errcode(new Error('fake error'), errCode)
      const key = uint8ArrayFromString('/v/hello')
      const value = uint8ArrayFromString('world')

      const [dhtA, dhtB, dhtC, dhtD] = await tdht.spawn(4, {
        clientMode: false
      })

      // Stub verify record
      dhtD._validators.v = {
        ...dhtD._validators.v,
        func: sinon.stub().rejects(error)
      }

      await Promise.all([
        tdht.connect(dhtA, dhtB),
        tdht.connect(dhtA, dhtC),
        tdht.connect(dhtA, dhtD)
      ])

      // DHT operations
      await dhtA.put(key, value, { minPeers: 2 })
      const res = await dhtB.get(key)

      expect(res).to.eql(value)
    })

    it('put - should fail if not enough peers can be written to', async function () {
      this.timeout(10 * 1000)

      const errCode = 'ERR_NOT_AVAILABLE'
      const error = errcode(new Error('fake error'), errCode)
      const key = uint8ArrayFromString('/v/hello')
      const value = uint8ArrayFromString('world')

      const [dhtA, dhtB, dhtC, dhtD] = await tdht.spawn(4, {
        clientMode: false
      })

      // Stub verify record
      dhtD._validators.v = {
        ...dhtD._validators.v,
        func: sinon.stub().rejects(error)
      }
      dhtC._validators.v = {
        ...dhtC._validators.v,
        func: sinon.stub().rejects(error)
      }

      await Promise.all([
        tdht.connect(dhtA, dhtB),
        tdht.connect(dhtA, dhtC),
        tdht.connect(dhtA, dhtD)
      ])

      // DHT operations
      await expect(dhtA.put(key, value, { minPeers: 2 })).to.eventually.be.rejected().property('code', 'ERR_NOT_ENOUGH_PUT_PEERS')
    })

    it('put - should require all peers to be put to successfully if no minPeers specified', async function () {
      this.timeout(10 * 1000)

      const errCode = 'ERR_NOT_AVAILABLE'
      const error = errcode(new Error('fake error'), errCode)
      const key = uint8ArrayFromString('/v/hello')
      const value = uint8ArrayFromString('world')

      const [dhtA, dhtB, dhtC] = await tdht.spawn(3, {
        clientMode: false
      })

      // Stub verify record
      dhtC._validators.v = {
        ...dhtC._validators.v,
        func: sinon.stub().rejects(error)
      }

      await Promise.all([
        tdht.connect(dhtA, dhtB),
        tdht.connect(dhtA, dhtC)
      ])

      // DHT operations
      await expect(dhtA.put(key, value)).to.eventually.be.rejected().property('code', 'ERR_NOT_ENOUGH_PUT_PEERS')
    })

    it('put - get using key with no prefix (no selector available)', async function () {
      this.timeout(10 * 1000)

      const key = uint8ArrayFromString('hello')
      const value = uint8ArrayFromString('world')

      const [dhtA, dhtB] = await tdht.spawn(2, {
        clientMode: false
      })

      await tdht.connect(dhtA, dhtB)

      // DHT operations
      await dhtA.put(key, value)
      const res = await dhtB.get(key)

      expect(res).to.eql(value)
    })

    it('put - get using key from provided validator and selector', async function () {
      this.timeout(10 * 1000)

      const key = uint8ArrayFromString('/ipns/hello')
      const value = uint8ArrayFromString('world')

      const [dhtA, dhtB] = await tdht.spawn(2, {
        validators: {
          ipns: {
            func: (key, record) => Promise.resolve(true)
          }
        },
        selectors: {
          ipns: (key, records) => 0
        },
        clientMode: false
      })

      await tdht.connect(dhtA, dhtB)

      // DHT operations
      await dhtA.put(key, value)
      const res = await dhtB.get(key)

      expect(res).to.eql(value)
    })

    it('put - get should fail if unrecognized key prefix in get', async function () {
      this.timeout(10 * 1000)

      const key = uint8ArrayFromString('/v2/hello')
      const value = uint8ArrayFromString('world')

      const [dhtA, dhtB] = await tdht.spawn(2, {
        clientMode: false
      })

      await tdht.connect(dhtA, dhtB)

      await dhtA.put(key, value)

      await expect(dhtA.get(key)).to.eventually.be.rejected().property('code', 'ERR_UNRECOGNIZED_KEY_PREFIX')
    })

    it('put - get with update', async function () {
      this.timeout(20 * 1000)

      const key = uint8ArrayFromString('/v/hello')
      const valueA = uint8ArrayFromString('worldA')
      const valueB = uint8ArrayFromString('worldB')

      const [dhtA, dhtB] = await tdht.spawn(2, {
        clientMode: false
      })

      const dhtASpy = sinon.spy(dhtA._network, 'sendRequest')

      // Put before peers connected
      await dhtA.put(key, valueA)
      await dhtB.put(key, valueB)

      // Connect peers
      await tdht.connect(dhtA, dhtB)

      // Get values
      const resA = await dhtA.get(key)
      const resB = await dhtB.get(key)

      // First is selected
      expect(resA).to.eql(valueA)
      expect(resB).to.eql(valueA)

      expect(dhtASpy.callCount).to.eql(2)

      expect(dhtASpy.getCall(0).args[0].equals(dhtB._libp2p.peerId)).to.be.true() // query B
      expect(MESSAGE_TYPE_LOOKUP[dhtASpy.getCall(0).args[1].type]).to.equal('GET_VALUE') // query B

      expect(dhtASpy.getCall(1).args[0].equals(dhtB._libp2p.peerId)).to.be.true() // update B
      expect(MESSAGE_TYPE_LOOKUP[dhtASpy.getCall(1).args[1].type]).to.equal('PUT_VALUE') // update B
    })

    it('layered get', async function () {
      this.timeout(40 * 1000)

      const key = uint8ArrayFromString('/v/hello')
      const value = uint8ArrayFromString('world')

      const nDHTs = 4

      const dhts = await tdht.spawn(nDHTs, {
        clientMode: false
      })

      // Connect all
      await Promise.all([
        tdht.connect(dhts[0], dhts[1]),
        tdht.connect(dhts[1], dhts[2]),
        tdht.connect(dhts[2], dhts[3])
      ])

      // DHT operations
      await dhts[3].put(key, value)
      const res = await dhts[0].get(key)

      expect(res).to.eql(value)
    })

    it('getMany with nvals=1 goes out to swarm if there is no local value', async () => {
      const key = uint8ArrayFromString('/v/hello')
      const value = uint8ArrayFromString('world')
      const rec = new Record(key, value)

      const [dht] = await tdht.spawn(1, {
        clientMode: false
      })

      // Simulate returning a peer id to query
      sinon.stub(dht._routingTable, 'closestPeers').returns([peerIds[1]]),
      // Simulate going out to the network and returning the record
      sinon.stub(dht._peerRouting, 'getValueOrPeers').callsFake(async () => ({ record: rec })) // eslint-disable-line require-await

      const res = await all(dht.getMany(key, 1))

      expect(res.length).to.eql(1)
      expect(res[0].value).to.eql(value)
    })
  })

  describe('content routing', () => {
    it('provides', async function () {
      this.timeout(20 * 1000)

      const dhts = await tdht.spawn(4, {
        clientMode: false
      })

      const ids = dhts.map((d) => d._libp2p.peerId)
      const idsB58 = ids.map(id => id.toB58String())
      sinon.spy(dhts[3]._network, 'sendMessage')

      // connect peers
      await Promise.all([
        tdht.connect(dhts[0], dhts[1]),
        tdht.connect(dhts[1], dhts[2]),
        tdht.connect(dhts[2], dhts[3])
      ])

      // provide values
      await Promise.all(values.map((value) => dhts[3].provide(value.cid)))

      // Expect an ADD_PROVIDER message to be sent to each peer for each value
      const fn = dhts[3]._network.sendMessage
      const valuesBuffs = values.map(v => v.cid.bytes)
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
      await pEachSeries(values, async (v) => {
        n = (n + 1) % 3

        const provs = await all(dhts[n].findProviders(v.cid))
        expect(provs).to.have.length(1)
        expect(provs[0].id).to.equalBytes(ids[3].id)
      })
    })

    it('find providers', async function () {
      this.timeout(20 * 1000)

      const val = values[0]

      const dhts = await tdht.spawn(3, {
        clientMode: false
      })

      // Connect
      await Promise.all([
        tdht.connect(dhts[0], dhts[1]),
        tdht.connect(dhts[1], dhts[2])
      ])

      await Promise.all(dhts.map((dht) => dht.provide(val.cid)))

      const res0 = await all(dhts[0].findProviders(val.cid))
      const res1 = await all(dhts[0].findProviders(val.cid, { maxNumProviders: 2 }))

      // find providers find all the 3 providers
      expect(res0).to.exist()
      expect(res0).to.have.length(3)

      // find providers limited to a maximum of 2 providers
      expect(res1).to.exist()
      expect(res1).to.have.length(2)
    })

    it('find providers from client', async function () {
      this.timeout(20 * 1000)

      const val = values[0]

      const dhts = await tdht.spawn(2, {
        clientMode: false
      })
      const [clientDHT] = await tdht.spawn(1, { clientMode: true })

      // Connect
      await Promise.all([
        tdht.connect(clientDHT, dhts[0]),
        tdht.connect(dhts[0], dhts[1])
      ])

      await Promise.all(dhts.map((dht) => dht.provide(val.cid)))

      const res0 = await all(clientDHT.findProviders(val.cid))
      const res1 = await all(clientDHT.findProviders(val.cid, { maxNumProviders: 1 }))

      // find providers find all the 2 providers
      expect(res0).to.exist()
      expect(res0).to.have.length(2)

      // find providers limited to a maxium of 1 providers
      expect(res1).to.exist()
      expect(res1).to.have.length(1)
    })

    it('find client provider', async function () {
      this.timeout(20 * 1000)

      const val = values[0]

      const dhts = await tdht.spawn(2, {
        clientMode: false
      })
      const [clientDHT] = await tdht.spawn(1, { clientMode: true })

      // Connect
      await Promise.all([
        tdht.connect(clientDHT, dhts[0]),
        tdht.connect(dhts[0], dhts[1])
      ])

      await clientDHT.provide(val.cid)

      await delay(1e3)

      const res = await all(dhts[1].findProviders(val.cid))

      // find providers find the client provider
      expect(res).to.exist()
      expect(res).to.have.length(1)
    })

    it('find one provider locally', async function () {
      this.timeout(20 * 1000)
      const val = values[0]

      const [dht] = await tdht.spawn(1, {
        clientMode: false
      })

      sinon.stub(dht._providers, 'getProviders').returns([dht._libp2p.peerId])

      // Find provider
      const res = await all(dht.findProviders(val.cid, { maxNumProviders: 1 }))

      expect(res).to.exist()
      expect(res).to.have.length(1)
    })
  })

  describe('peer routing', () => {
    it('findPeer', async function () {
      this.timeout(40 * 1000)

      const dhts = await tdht.spawn(4, {
        clientMode: false
      })

      // Connect all
      await Promise.all([
        tdht.connect(dhts[0], dhts[1]),
        tdht.connect(dhts[1], dhts[2]),
        tdht.connect(dhts[2], dhts[3])
      ])

      const ids = dhts.map((d) => d._libp2p.peerId)
      const res = await dhts[0].findPeer(ids[3])
      expect(res.id.isEqual(ids[3])).to.eql(true)
    })

    it('find peer query', async function () {
      this.timeout(40 * 1000)

      // Create 101 nodes
      const nDHTs = 100

      const dhts = await tdht.spawn(nDHTs, {
        clientMode: false
      })

      const dhtsById = new Map(dhts.map((d) => [d._libp2p.peerId, d]))
      const ids = [...dhtsById.keys()]

      // The origin node for the FIND_PEER query
      const originNode = dhts[0]

      // The key
      const val = uint8ArrayFromString('foobar')

      // Hash the key into the DHT's key format
      const rtval = await kadUtils.convertBuffer(val)
      // Make connections between nodes close to each other
      const sorted = await sortClosestPeers(ids, rtval)

      const conns = []
      const maxRightIndex = sorted.length - 1
      for (let i = 0; i < sorted.length; i++) {
        // Connect to 5 nodes on either side (10 in total)
        for (const distance of [1, 3, 11, 31, 63]) {
          let rightIndex = i + distance
          if (rightIndex > maxRightIndex) {
            rightIndex = maxRightIndex * 2 - (rightIndex + 1)
          }
          let leftIndex = i - distance
          if (leftIndex < 0) {
            leftIndex = 1 - leftIndex
          }
          conns.push([sorted[leftIndex], sorted[rightIndex]])
        }
      }

      await Promise.all(conns.map((conn) => tdht.connect(dhtsById.get(conn[0]), dhtsById.get(conn[1]))))

      // Get the alpha (3) closest peers to the key from the origin's
      // routing table
      const rtablePeers = originNode._routingTable.closestPeers(rtval, c.ALPHA)
      expect(rtablePeers).to.have.length(c.ALPHA)

      // The set of peers used to initiate the query (the closest alpha
      // peers to the key that the origin knows about)
      const rtableSet = {}
      rtablePeers.forEach((p) => {
        rtableSet[p.toB58String()] = true
      })

      const originNodeIndex = ids.findIndex(i => uint8ArrayEquals(i.id, originNode._libp2p.peerId.id))
      const otherIds = ids.slice(0, originNodeIndex).concat(ids.slice(originNodeIndex + 1))

      // Make the query
      const out = await all(originNode.getClosestPeers(val))
      const actualClosest = await sortClosestPeers(otherIds, rtval)

      // Expect that the response includes nodes that are were not
      // already in the origin's routing table (ie it went out to
      // the network to find closer peers)
      expect(out.filter((p) => !rtableSet[p.toB58String()]))
        .to.not.be.empty()

      // The expected closest kValue peers to the key
      const exp = actualClosest.slice(0, c.K)

      // Expect the kValue peers found to include the kValue closest connected peers
      // to the key
      expect(countDiffPeers(out, exp)).to.equal(0)
    })
  })

  describe('getPublicKey', () => {
    it('already known', async function () {
      this.timeout(20 * 1000)

      const dhts = await tdht.spawn(2, {
        clientMode: false
      })

      const ids = dhts.map((d) => d._libp2p.peerId)
      dhts[0]._libp2p.peerStore.addressBook.add(dhts[1]._libp2p.peerId, [new Multiaddr('/ip4/160.1.1.1/tcp/80')])

      const key = await dhts[0].getPublicKey(ids[1])
      expect(key).to.eql(dhts[1]._libp2p.peerId.pubKey)

      await delay(100)
    })

    it('connected node', async function () {
      this.timeout(30 * 1000)

      const dhts = await tdht.spawn(2, {
        clientMode: false
      })

      const ids = dhts.map((d) => d._libp2p.peerId)

      await tdht.connect(dhts[0], dhts[1])

      dhts[0]._libp2p.peerStore.addressBook.add(dhts[1]._libp2p.peerId, [new Multiaddr('/ip4/160.1.1.1/tcp/80')])

      const key = await dhts[0].getPublicKey(ids[1])
      expect(uint8ArrayEquals(key, dhts[1]._libp2p.peerId.pubKey)).to.eql(true)
    })
  })

  describe('errors', () => {
    it('get many should fail if only has one peer', async function () {
      this.timeout(20 * 1000)

      const dhts = await tdht.spawn(1, {
        clientMode: false
      })

      // TODO: Switch not closing well, but it will be removed
      // (invalid transition: STOPPED -> done)
      await delay(100)

      await expect(all(dhts[0].getMany(uint8ArrayFromString('/v/hello'), 5))).to.eventually.be.rejected().property('code', 'ERR_NO_PEERS_IN_ROUTING_TABLE')

      // TODO: after error switch
    })

    it('findPeer should fail if no closest peers available', async function () {
      this.timeout(40 * 1000)

      const dhts = await tdht.spawn(4, {
        clientMode: false
      })

      const ids = dhts.map((d) => d._libp2p.peerId)
      await Promise.all([
        tdht.connect(dhts[0], dhts[1]),
        tdht.connect(dhts[1], dhts[2]),
        tdht.connect(dhts[2], dhts[3])
      ])

      const stub = sinon.stub(dhts[0]._routingTable, 'closestPeers').returns([])

      await expect(dhts[0].findPeer(ids[3])).to.eventually.be.rejected().property('code', 'ERR_LOOKUP_FAILED')

      stub.restore()
    })

    it('should not find peers with different protocols', async function () {
      this.timeout(40 * 1000)

      const protocol1 = '/test1'
      const protocol2 = '/test2'

      const dhts = []
      dhts.push(...await tdht.spawn(2, {
        clientMode: false,
        protocolPrefix: protocol1
      }))
      dhts.push(...await tdht.spawn(2, {
        clientMode: false,
        protocolPrefix: protocol2
      }))

      // Connect all
      await Promise.all([
        tdht.connect(dhts[0], dhts[1]),
        tdht.connect(dhts[1], dhts[2]),
        tdht.connect(dhts[2], dhts[3])
      ])

      const ids = dhts.map((d) => d._libp2p.peerId)

      await expect(dhts[0].findPeer(ids[3])).to.eventually.be.rejected().property('code', 'ERR_NOT_FOUND')
    })

    it('force legacy protocol', async function () {
      this.timeout(40 * 1000)

      const protocol = '/test/dht/0.0.0'

      const [dht] = await tdht.spawn(1, {
        clientMode: false,
        protocolPrefix: protocol,
        forceProtocolLegacy: true
      })

      expect(dht._protocol).to.eql(protocol)
    })
  })
})
