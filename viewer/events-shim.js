// Browser shim for Node's "events" (pulled by xmlbuilder2's callback writer, which we never invoke).
class EventEmitter {
  on() { return this; } once() { return this; } off() { return this; }
  addListener() { return this; } removeListener() { return this; } emit() { return false; }
}
export { EventEmitter };
export default EventEmitter;
