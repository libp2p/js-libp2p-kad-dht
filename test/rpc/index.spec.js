/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect
const pDefer = require('p-defer')
const pipe = require('it-pipe')
const lp = require('it-length-prefixed')

const Message = require('../../src/message')
const rpc = require('../../src/rpc')

const createPeerInfo = require('../utils/create-peer-info')
const TestDHT = require('../utils/test-dht')

describe('rpc', () => {
  let peerInfos
  let tdht

  before(async () => {
    peerInfos = await createPeerInfo(2)
    tdht = new TestDHT()
  })

  it('calls back with the response', async () => {
    const defer = pDefer()
    const [dht] = await tdht.spawn(1)

    dht.peerStore.put(peerInfos[1])

    const msg = new Message(Message.TYPES.GET_VALUE, Buffer.from('hello'), 5)

    const validateMessage = (res) => {
      const msg = Message.deserialize(res[0])
      expect(msg).to.have.property('key').eql(Buffer.from('hello'))
      expect(msg).to.have.property('closerPeers').eql([])
      defer.resolve()
    }

    const data = []
    await pipe(
      [msg.serialize()],
      lp.encode(),
      async source => {
        for await (const chunk of source) {
          data.push(chunk.slice())
        }
      }
    )

    const duplexStream = {
      source: function * () {
        const array = data

        while (array.length) {
          yield array.shift()
        }
      },
      sink: async (source) => {
        const res = []
        await pipe(
          source,
          lp.decode(),
          async source => {
            for await (const chunk of source) {
              res.push(chunk.slice())
            }
          }
        )
        validateMessage(res)
      }
    }

    rpc(dht)({
      protocol: 'protocol',
      stream: duplexStream,
      connection: {
        remotePeer: peerInfos[1].id
      }
    })

    return defer.promise
  })
})
