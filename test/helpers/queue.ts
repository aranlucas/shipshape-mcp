/** Queue metrics returned by successful sends in Worker fixtures. */
export const queueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
} satisfies QueueSendResponse & QueueSendBatchResponse;
