/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect

const QueryManager = require('../src/query-manager')

describe('QueryManager', () => {
  it('basics', () => {
    const queryManager = new QueryManager()

    let stopped = 0
    const fakeQuery = () => ({
      stop () {
        stopped++
      }
    })

    const queries = [fakeQuery(), fakeQuery(), fakeQuery(), fakeQuery()]
    queryManager.started(queries[0])
    queryManager.started(queries[1])
    queryManager.started(queries[2])
    queryManager.started(queries[3])
    queryManager.stopped(queries[1])
    queryManager.stopQueries()

    expect(stopped).to.eql(3)
  })

  it('can stop empty query manager', () => {
    const queryManager = new QueryManager()
    queryManager.stopQueries()
  })
})
