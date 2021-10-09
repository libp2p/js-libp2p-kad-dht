/* eslint-env mocha */
'use strict'

const { expect } = require('aegir/utils/chai')
const { Message } = require('../../../src/message')
const utils = require('../../../src/utils')
const { GetProvidersHandler } = require('../../../src/rpc/handlers/get-providers')
const { fromString: uint8ArrayFromString } = require('uint8arrays/from-string')

const T = Message.TYPES.GET_PROVIDERS

const createPeerId = require('../../utils/create-peer-id')
const createValues = require('../../utils/create-values')
const TestDHT = require('../../utils/test-dht')

describe('rpc - handlers - GetProviders', () => {
  let peerIds
  let values
  let tdht
  let dht
  let handler

  before(async () => {
    tdht = new TestDHT()

    ;[peerIds, values] = await Promise.all([
      createPeerId(3),
      createValues(2)
    ])
  })

  beforeEach(async () => {
    const dhts = await tdht.spawn(1)
    dht = dhts[0]

    handler = new GetProvidersHandler(
      dht._libp2p.peerId,
      dht._peerRouting,
      dht._providers,
      dht._datastore,
      dht._libp2p.peerStore
    )
  })

  afterEach(() => tdht.teardown())

  it('errors with an invalid key ', async () => {
    const handler = new GetProvidersHandler(
      dht._libp2p.peerId,
      dht._peerRouting,
      dht._providers,
      dht._datastore,
      dht._libp2p.peerStore
    )
    const msg = new Message(T, uint8ArrayFromString('hello'), 0)

    await expect(handler.handle(peerIds[0], msg)).to.eventually.be.rejected().with.property('code', 'ERR_INVALID_CID')
  })

  it('responds with self if the value is in the datastore', async () => {
    const v = values[0]

    const msg = new Message(T, v.cid.bytes, 0)
    const dsKey = utils.bufferToKey(v.cid.bytes)

    await dht._datastore.put(dsKey, v.value)
    const response = await handler.handle(peerIds[0], msg)

    expect(response.key).to.be.eql(v.cid.bytes)
    expect(response.providerPeers).to.have.length(1)
    expect(response.providerPeers[0].id.toB58String())
      .to.equal(dht._libp2p.peerId.toB58String())
  })

  it('responds with listed providers and closer peers', async () => {
    const v = values[0]

    const msg = new Message(T, v.cid.bytes, 0)
    const prov = peerIds[1]
    const closer = peerIds[2]

    await dht._routingTable.add(closer)
    await dht._providers.addProvider(v.cid, prov)
    const response = await handler.handle(peerIds[0], msg)

    expect(response.key).to.be.eql(v.cid.bytes)
    expect(response.providerPeers).to.have.length(1)
    expect(response.providerPeers[0].id.toB58String())
      .to.equal(prov.toB58String())

    expect(response.closerPeers).to.have.length(1)
    expect(response.closerPeers[0].id.toB58String())
      .to.equal(closer.toB58String())
  })
})
