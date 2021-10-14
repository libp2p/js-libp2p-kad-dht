'use strict'

const { MESSAGE_TYPE_LOOKUP } = require('../message')

/**
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('../types').QueryEvent} QueryEvent
 * @typedef {import('../types').PeerData} PeerData
 * @typedef {import('../message').Message} Message
 */

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @param {number} fields.type
 * @returns {import('../types').SendingQueryEvent}
 */
function sendingQueryEvent (fields) {
  return {
    ...fields,
    name: 'sendingQuery',
    type: 0,
    message: MESSAGE_TYPE_LOOKUP[fields.type],
    messageType: fields.type
  }
}

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @param {PeerData[]} [fields.closerPeers]
 * @param {Message} [fields.response]
 * @returns {import('../types').PeerResponseEvent}
 */
function peerResponseEvent (fields) {
  return {
    ...fields,
    name: 'peerResponse',
    type: 1
  }
}

/**
 * @param {object} fields
 * @param {PeerData} fields.peer
 * @returns {import('../types').FinalPeerEvent}
 */
function finalPeerEvent (fields) {
  return {
    ...fields,
    name: 'finalPeer',
    type: 2
  }
}

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @param {Error} fields.error
 * @returns {import('../types').QueryErrorEvent}
 */
function queryErrorEvent (fields) {
  return {
    ...fields,
    name: 'queryError',
    type: 3
  }
}

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @param {PeerData[]} fields.providerPeers
 * @returns {import('../types').ProviderEvent}
 */
function providerEvent (fields) {
  return {
    ...fields,
    name: 'provider',
    type: 4
  }
}

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @param {Uint8Array} fields.value
 * @returns {import('../types').ValueEvent}
 */
function valueEvent (fields) {
  return {
    ...fields,
    name: 'value',
    type: 5
  }
}

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @returns {import('../types').AddingPeerEvent}
 */
function addingPeerEvent (fields) {
  return {
    ...fields,
    name: 'addingPeer',
    type: 6
  }
}

/**
 * @param {object} fields
 * @param {PeerId} fields.peer
 * @returns {import('../types').DialingPeerEvent}
 */
function dialingPeerEvent (fields) {
  return {
    ...fields,
    name: 'dialingPeer',
    type: 7
  }
}

module.exports = {
  sendingQueryEvent,
  peerResponseEvent,
  finalPeerEvent,
  queryErrorEvent,
  providerEvent,
  valueEvent,
  addingPeerEvent,
  dialingPeerEvent
}
