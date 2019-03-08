/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect
const { collect } = require('streaming-iterables')
const EventEmitter = require('events')

const QueueTransform = require('../src/queue-transform')

class TestQueue extends EventEmitter {
  constructor () {
    super()
    this.items = []
  }

  enqueue (item) {
    this.items.push(item)
    this.emit('enqueued')
  }

  dequeue () {
    return this.items.shift()
  }

  get length () {
    return this.items.length
  }
}

describe('QueueTransform', () => {
  describe('iteration with stop', () => {
    it(`queue stops yielding after stop() called`, async () => {
      const processFn = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 10))

      const queue = new TestQueue()
      for (let i = 0; i < 3; i++) {
        queue.enqueue('item ' + i)
      }

      let results = []
      const iterator = new QueueTransform(queue, processFn, 1)
      for await (const res of iterator) {
        results.push(res)
        iterator.stop()
      }
      expect(results.length).to.eql(2)
    })
  })

  describe('basic iteration', () => {
    const queueLengths = [0, 1, 2, 4, 5, 8, 20]
    const concurrencies = [undefined, 1, 2, 3, 4, 8, 20]
    const processFns = [{
      name: 'synchronous process function',
      fn: () => {}
    }, {
      name: 'asynchronous process function',
      fn: () => new Promise((resolve) => setTimeout(resolve, Math.random() * 10))
    }]

    for (const processFn of processFns) {
      describe(`with ${processFn.name}`, () => {
        for (const concurrency of concurrencies) {
          describe(`with concurrency ${concurrency}`, () => {
            for (const queueLength of queueLengths) {
              it(`${queueLength} element queue yields ${queueLength} results`, async () => {
                const queue = new TestQueue()
                for (let i = 0; i < queueLength; i++) {
                  queue.enqueue('item ' + i)
                }

                const res = await collect(new QueueTransform(queue, processFn.fn, concurrency))
                expect(res.length).to.eql(queueLength)
              })
            }
          })
        }
      })
    }
  })

  describe('iteration with recursive enqueueing', () => {
    const concurrencies = [undefined, 1, 2, 3, 4, 8, 20]
    const queueLengths = [{
      length: 0,
      expected: 0
    }, {
      length: 1,
      expected: 4
    }, {
      length: 2,
      expected: 5
    }, {
      length: 4,
      expected: 10
    }, {
      length: 5,
      expected: 14
    }, {
      length: 8,
      expected: 20
    }, {
      length: 20,
      expected: 50
    }]

    describe(`with synchronous process function`, () => {
      for (const concurrency of concurrencies) {
        describe(`with concurrency ${concurrency}`, () => {
          for (const { length, expected } of queueLengths) {
            it(`${length} element queue yields ${expected} results`, async () => {
              let n = 0
              const processFn = () => {
                if (n % 5 === 0) {
                  queue.enqueue('item')
                  queue.enqueue('item')
                  queue.enqueue('item')
                }
                n++
              }

              const queue = new TestQueue()
              for (let i = 0; i < length; i++) {
                queue.enqueue('item ' + i)
              }

              const res = await collect(new QueueTransform(queue, processFn, concurrency))
              expect(res.length).to.eql(expected)
            })
          }
        })
      }
    })

    describe(`with asynchronous process function`, () => {
      for (const concurrency of concurrencies) {
        describe(`with concurrency ${concurrency}`, () => {
          for (const { length, expected } of queueLengths) {
            it(`${length} element queue yields ${expected} results`, async () => {
              let n = 0
              const processFn = async () => {
                await new Promise((resolve) => setTimeout(resolve, Math.random() * 10))
                if (n % 5 === 0) {
                  queue.enqueue('item')
                  queue.enqueue('item')
                  queue.enqueue('item')
                }
                n++
              }

              const queue = new TestQueue()
              for (let i = 0; i < length; i++) {
                queue.enqueue('item ' + i)
              }

              const res = await collect(new QueueTransform(queue, processFn, concurrency))
              expect(res.length).to.eql(expected)
            })
          }
        })
      }
    })
  })

  describe('error handling', () => {
    const concurrencies = [undefined, 1, 2, 3, 4]

    describe(`with recursively enqueueing synchronous process function`, () => {
      for (const concurrency of concurrencies) {
        describe(`with concurrency ${concurrency}`, () => {
          it('throws task function errors', async () => {
            let n = 0
            const processFn = () => {
              n++
              if (n === 2) {
                queue.enqueue('item')
                queue.enqueue('item')
              }
              if (n === 3) {
                throw new Error('fail')
              }
            }

            const queue = new TestQueue()
            for (let i = 0; i < 3; i++) {
              queue.enqueue('item ' + i)
            }

            try {
              await collect(new QueueTransform(queue, processFn, concurrency))
            } catch (err) {
              expect(err.message).to.eql('fail')
              return
            }
            expect.fail('Did not throw error')
          })
        })
      }
    })

    describe(`with recursively enqueueing asynchronous process function`, () => {
      for (const concurrency of concurrencies) {
        describe(`with concurrency ${concurrency}`, () => {
          it('throws task function errors', async () => {
            let n = 0
            const processFn = () => {
              return new Promise((resolve, reject) => {
                setTimeout(() => {
                  n++
                  if (n === 2) {
                    queue.enqueue('item')
                    queue.enqueue('item')
                  }
                  if (n === 3) {
                    return reject(new Error('fail'))
                  }
                  resolve()
                }, Math.random() * 10)
              })
            }

            const queue = new TestQueue()
            for (let i = 0; i < 3; i++) {
              queue.enqueue('item ' + i)
            }

            try {
              await collect(new QueueTransform(queue, processFn, concurrency))
            } catch (err) {
              expect(err.message).to.eql('fail')
              return
            }
            expect.fail('Did not throw error')
          })
        })
      }
    })
  })
})
