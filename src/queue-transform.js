'use strict'

const EventEmitter = require('events')

/**
 * Queue of items that fires 'enqueued' when an item is added to the queue.
 *
 * @typedef {Object} TransformableQueue
 * @property {number} length
 * @function {() => Object} dequeue - removes an item from the queue and returns it
 */

/**
 * QueueTransform is an Asynchronous Iterable that operates over a
 * TransformQueue, running `processFn` on `concurrency` queue items at a time.
 */
class QueueTransform extends EventEmitter {
  /**
   * Create a new QueueTransform.
   *
   * @param {TransformableQueue} queue
   * @param {function} processFn
   * @param {number} concurrency
   */
  constructor (queue, processFn, concurrency = 1) {
    super()

    this.hydrate = this.hydrate.bind(this)

    this.queue = queue
    this.processFn = processFn
    this.concurrency = concurrency

    this.running = []
    this.completed = []
    this.errors = []
  }

  /**
   * Stop iterating.
   */
  stop () {
    this.iterating = false
    this.removeAllListeners()
    this.queue.removeListener('enqueued', this.hydrate)
  }

  /**
   * Get items from the queue to be iterated over.
   */
  hydrate () {
    if (!this.iterating) {
      return
    }

    try {
      this._hydrate()
    } catch (err) {
      this.iterating = false
      throw err
    }
  }

  /**
   * Get items from the queue to be iterated over.
   */
  _hydrate () {
    // While there are items in the queue, and we're not already at the
    // concurrency limit
    while (this.queue.length && this.running.length < this.concurrency) {
      // Get the next item
      const item = this.queue.dequeue()

      // Process the item
      const task = this.processFn(item)

      if (task instanceof Promise) {
        // If the task is a Promise, add the task to the list of running tasks
        this.running.push(task)
        task.then(() => {
          // When the task completes, remove it from the list of running tasks
          // and add it to the list of completed tasks
          this.running.splice(this.running.indexOf(task), 1)
          this.completed.push(task)
          this.emit('task complete')
        }).catch((err) => {
          // If there's an error, stop the iterator and add the error to the
          // list of errors
          this.iterating = false
          this.errors.push(err)
          this.emit('task error', err)
        })
      } else {
        // If the task is not a Promise, it has completed already, so just add
        // it to the list of completed tasks
        this.completed.push(task)
        this.emit('task complete')
      }
    }

    if (this.queue.length) {
      // If there are still items in the queue, but we've reached the
      // concurrency limit, wait for a task to complete and then hydrate again
      this.once('task complete', this.hydrate)
    } else {
      // If there are no items in the queue, wait for a task
      this.queue.once('enqueued', this.hydrate)
    }
  }

  /**
   * Retrieve the next item from the iterator.
   */
  async next () {
    // If we have any completed tasks, return the most recently completed one
    if (this.completed.length) {
      const value = await this.completed.shift()
      return { done: false, value }
    }

    // If there was an error running a task, throw the error
    if (this.errors.length) {
      this.stop()
      throw this.errors[0]
    }

    // If there are any tasks running, return a Promise that resolves when
    // the task completes
    if (this.running.length) {
      await new Promise((resolve) => {
        const done = () => {
          this.removeListener('task complete', done)
          this.removeListener('task error', done)
          resolve()
        }
        this.once('task complete', done)
        this.once('task error', done)
      })
      return this.next()
    }

    // We don't have any completed or running tasks, so we're done
    this.stop()
    return { done: true }
  }

  /**
   * Get the iterator itself.
   *
   * @returns {AsyncIterator}
   */
  [Symbol.asyncIterator] () {
    // Hydrate the iterator with tasks
    this.iterating = true
    this.hydrate()
    return this
  }
}

module.exports = QueueTransform
