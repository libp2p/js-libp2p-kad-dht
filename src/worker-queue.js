'use strict'

const Queue = require('p-queue')
const EventEmitter = require('events')
const debug = require('debug')

const log = debug('libp2p:dht:worker-queue')

/**
 * WorkerQueue is a queue that executes a set of tasks.
 */
class WorkerQueue extends EventEmitter {
  /**
   * Queue of items that can be dequeued.
   *
   * @typedef {SourceQueue} Object
   * @param {function} dequeue - the next item to be processed
   * @param {number} length - the length of the queue
   */

  /**
   * Processes a task. If the work is complete, this function should return
   * true (or Promise<true>), in which case no more tasks will be processed.
   *
   * @typedef {TaskProcessor} function
   * @param {WorkerQueue} queue
   * @param {Object} task - task to be processed
   * @returns {Promise<Boolean>} true if the work is complete
   */

  /**
   * Create with a given source queue and task processor.
   *
   * @param {SourceQueue} source
   * @param {TaskProcessor} processTask - processes a task in the queue
   * @param {Object} options - options
   * @param {number} options.concurrency - concurrency of processing (default: 1)
   */
  constructor (source, processTask, options = {}) {
    super()
    this.source = source
    this.processTask = processTask
    this.concurrency = options.concurrency || 1
    this.q = new Queue({ concurrency: this.concurrency })

    this.running = true
    this._hydrate()
  }

  /**
   * Stop the queue and wait for it to finish processing
   *
   * @returns {Promise}
   */
  stop () {
    this.q.clear()
    this.running = false
    const onComplete = this.onComplete()
    this.emit('stopped')
    return onComplete
  }

  /**
   * Wait for the queue to complete
   *
   * @returns {Promise}
   */
  async onComplete () {
    this._onCompletePromise = this._onCompletePromise || new Promise((resolve, reject) => {
      this.once('stopped', resolve)
      this.once('err', reject)
    })
    return this._onCompletePromise.then(() => log('drain'))
  }

  _hydrate () {
    log('hydrate (%d in progress, %d waiting)', this.q.pending, this.q.size)
    // Note: q.pending is the number of tasks that are currently running, so we
    // want to keep adding items until this equals the concurrency limit
    while (this.q.pending < this.concurrency && this.source.length > 0) {
      const peer = this.source.dequeue()

      // Add tasks to the queue without waiting for them to finish
      this._addTask(peer)
    }
    log('hydrated (%d in progress, %d waiting)', this.q.pending, this.q.size)
  }

  async _addTask (task) {
    const taskPromise = this.q.add(() => this.processTask(this, task))

    // Wait for the task to finish
    let done
    try {
      done = await taskPromise
    } catch (err) {
      this.emit('err', err)
      return
    }

    // If the task indicates that we're done, bail out
    if (done) {
      this.stop()
      return
    }

    // Hydrate the queue with more tasks
    log('unsaturated (%d in progress, %d waiting)', this.q.pending, this.q.size)
    this._hydrate()

    // If no more tasks were found then we're done
    if (this.q.pending === 0) {
      this.stop()
    }
  }
}

module.exports = WorkerQueue
