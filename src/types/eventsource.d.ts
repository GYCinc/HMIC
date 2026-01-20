import { EventSource as OriginalEventSource } from "eventsource";

declare global {
  // eslint-disable-next-line no-var
  var EventSource: typeof OriginalEventSource;
}
