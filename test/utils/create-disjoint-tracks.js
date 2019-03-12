'use strict'

const multihashing = require('multihashing-async')
const distance = require('xor-distance')

function convertPeerId (peer) {
  return multihashing.digest(peer.id, 'sha2-256')
}

async function sortClosestPeers (peers, target) {
  const distances = await Promise.all(peers.map(async (peer) => {
    const id = await convertPeerId(peer)
    return {
      peer: peer,
      distance: distance(id, target)
    }
  }))
  return distances.sort(xorCompare).map((d) => d.peer)
}

function xorCompare (a, b) {
  return distance.compare(a.distance, b.distance)
}

/*
 * Given an array of peerInfos, decide on a target, start peers, and
 * "next", a successor function for the query to use. See comment
 * where this is called for details.
 */
async function createDisjointTracks (peerInfos, goodLength) {
  const ids = peerInfos.map((info) => info.id)
  const us = ids[0]
  let target

  const ourId = await convertPeerId(us)
  let sorted = await sortClosestPeers(ids, ourId)
  target = sorted[sorted.length - 1]
  sorted = sorted.slice(1) // remove our id
  const goodTrack = sorted.slice(0, goodLength)
  goodTrack.push(target) // push on target
  const badTrack = sorted.slice(goodLength, -1)
  if (badTrack.length <= goodTrack.length) {
    throw new Error(`insufficient number of peers; good length: ${goodTrack.length}, bad length: ${badTrack.length}`)
  }
  const tracks = [goodTrack, badTrack] // array of arrays of nodes

  const getResponse = (peer, trackNum) => {
    const track = tracks[trackNum]
    const pos = track.indexOf(peer)
    if (pos < 0) {
      return null // peer not on expected track
    }

    const nextPos = pos + 1
    // if we're at the end of the track
    if (nextPos === track.length) {
      if (trackNum === 0) { // good track; success
        return {
          end: true,
          pathComplete: true
        }
      } else { // bad track; dead end
        return {
          end: true,
          closerPeers: []
        }
      }
    } else {
      const infoIdx = ids.indexOf(track[nextPos])
      return {
        closerPeers: [peerInfos[infoIdx]]
      }
    }
  }

  return {
    targetId: target.id,
    tracks: [goodTrack[0], badTrack[0]],
    getResponse
  }
}

module.exports = createDisjointTracks
