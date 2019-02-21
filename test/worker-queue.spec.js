/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect

const WorkerQueue = require('../src/worker-queue')

describe('WorkerQueue', () => {
  it('basics', async () => {
    const items = [1, 2, 3, 4]
    const taskQueue = {
      dequeue () {
        return items.shift()
      },
      get length () {
        return items.length
      }
    }

    const processTask = (q, task) => null
    const wq = new WorkerQueue(taskQueue, processTask)

    await wq.onComplete()

    expect(items.length).to.be.eql(0)
  })

  it('can stop before completion', async () => {
    const items = [1, 2, 3, 4]
    const taskQueue = {
      dequeue () {
        return new Promise((resolve) => {
          const item = items.shift()
          setTimeout(() => resolve(item), 100)
        })
      },
      get length () {
        return items.length
      }
    }

    const processTask = async (q, task) => {
      await task
    }
    const wq = new WorkerQueue(taskQueue, processTask)

    // Tasks take 100ms to process, so if we stop after 200ms
    // there should be at least one left in the queue
    setTimeout(() => wq.stop(), 200)

    await wq.onComplete()
    expect(items.length).to.be.gte(1)
  })

  it('can run multiple tasks concurrently', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    const taskQueue = {
      dequeue () {
        return new Promise((resolve) => {
          const item = items.shift()
          setTimeout(() => resolve(item), 0)
        })
      },
      get length () {
        return items.length
      }
    }

    const processTask = async (q, task) => {
      await task
    }
    const wq = new WorkerQueue(taskQueue, processTask, {
      concurrency: 4
    })

    await wq.onComplete()
    expect(items.length).to.be.eql(0)
  })

  it('can return true to stop before completion', async () => {
    const items = [1, 2, 3, 4]
    const taskQueue = {
      dequeue () {
        return items.shift()
      },
      get length () {
        return items.length
      }
    }

    const processTask = async (q, task) => {
      return (await task) === 2
    }
    const wq = new WorkerQueue(taskQueue, processTask)

    await wq.onComplete()
    expect(items.length).to.be.eql(2)
  })

  it('error thrown from task is thrown from onComplete()', async () => {
    const items = [1, 2, 3, 4]
    const taskQueue = {
      dequeue () {
        return items.shift()
      },
      get length () {
        return items.length
      }
    }

    const processTask = async (q, task) => {
      if ((await task) === 2) {
        throw new Error('Bad task')
      }
    }
    const wq = new WorkerQueue(taskQueue, processTask)

    try {
      await wq.onComplete()
    } catch (err) {
      expect(err.message).to.be.eql('Bad task')
    }
    expect(items.length).to.be.eql(2)
  })
})
