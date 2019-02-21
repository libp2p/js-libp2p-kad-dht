/* eslint-env mocha */
/* eslint max-nested-callbacks: ["error", 8] */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect
const _ = require('lodash')

const Message = require('../../../src/message')
const handler = require('../../../src/rpc/handlers/add-provider')

const createPeerInfo = require('../../utils/create-peer-info')
const createValues = require('../../utils/create-values')
const TestDHT = require('../../utils/test-dht')

describe('rpc - handlers - AddProvider', () => {
  let peers
  let values
  let tdht
  let dht

  before(async () => {
    const res = await Promise.all([
      createPeerInfo(3),
      createValues(2)
    ])
    peers = res[0]
    values = res[1]
  })

  beforeEach(async () => {
    tdht = new TestDHT()
    const dhts = await tdht.spawn(1)
    dht = dhts[0]
  })

  afterEach(() => tdht.teardown())

  describe('invalid messages', () => {
    const tests = [{
      message: new Message(Message.TYPES.ADD_PROVIDER, Buffer.alloc(0), 0),
      error: 'ERR_MISSING_KEY'
    }, {
      message: new Message(Message.TYPES.ADD_PROVIDER, Buffer.alloc(0), 0),
      error: 'ERR_MISSING_KEY'
    }, {
      message: new Message(Message.TYPES.ADD_PROVIDER, Buffer.from('hello world'), 0),
      error: 'ERR_INVALID_CID'
    }]

    tests.forEach((t) => it(t.error.toString(), async () => {
      try {
        await handler(dht)(peers[0], t.message)
      } catch (err) {
        expect(err.code).to.eql(t.error)
        return
      }
      expect.fail('expected error')
    }))
  })

  it('ignore providers not from the originator', async () => {
    const cid = values[0].cid

    const msg = new Message(Message.TYPES.ADD_PROVIDER, cid.buffer, 0)
    const sender = peers[0]
    sender.multiaddrs.add('/ip4/127.0.0.1/tcp/1234')
    const other = peers[1]
    other.multiaddrs.add('/ip4/127.0.0.1/tcp/2345')
    msg.providerPeers = [
      sender,
      other
    ]

    await handler(dht)(sender, msg)
    const provs = await dht.providers.getProviders(cid)
    expect(provs).to.have.length(1)
    expect(provs[0].id).to.eql(sender.id.id)
    const bookEntry = dht.peerBook.get(sender.id)
    expect(bookEntry.multiaddrs.toArray()).to.eql(sender.multiaddrs.toArray())
  })

  it('ignore providers with no multiaddrs', async () => {
    const cid = values[0].cid
    const msg = new Message(Message.TYPES.ADD_PROVIDER, cid.buffer, 0)
    const sender = _.cloneDeep(peers[0])
    sender.multiaddrs.clear()
    msg.providerPeers = [sender]

    await handler(dht)(sender, msg)
    const provs = await dht.providers.getProviders(cid)
    expect(provs).to.have.length(1)
    expect(provs[0].id).to.eql(sender.id.id)
    expect(dht.peerBook.has(sender.id)).to.equal(false)
  })
})
