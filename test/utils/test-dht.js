'use strict'

const PeerBook = require('peer-book')
const Switch = require('libp2p-switch')
const TCP = require('libp2p-tcp')
const Mplex = require('libp2p-mplex')

const createPeerInfo = require('./create-peer-info')

const KadDHT = require('../../src')

class TestDHT {
  constructor () {
    this.nodes = []
  }

  spawn (n, options) {
    return Promise.all([...new Array(n)].map(() => this._spawnOne(options)))
  }

  async _spawnOne (options) {
    const peers = await createPeerInfo(1)

    const p = peers[0]
    p.multiaddrs.add('/ip4/127.0.0.1/tcp/0')

    const sw = new Switch(p, new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()

    const dht = new KadDHT(sw, options)

    dht.validators.v = {
      func (key, publicKey) {},
      sign: false
    }

    dht.validators.v2 = dht.validators.v // added to simulate just validators available

    dht.selectors.v = (k, records) => 0

    await new Promise((resolve, reject) => sw.start((err) => err ? reject(err) : resolve()))
    await dht.start()

    this.nodes.push(dht)
    return dht
  }

  async teardown () {
    await Promise.all(this.nodes.map(async (n) => {
      await n.stop()
      return new Promise((resolve, reject) => n.switch.stop((err) => err ? reject(err) : resolve()))
    }))
    this.nodes = []
  }
}

module.exports = TestDHT
