import { expect, test } from 'bun:test'
import { qaMarker } from './remote/qa_marker.ts'
test('QA marker follows real remote context prefix and does not depend on a shared counter', () => {
  expect(qaMarker(['SSH target: ssh_fixture\nRemote root identity: fixture.\nQA_REMOTE_WRITE'])).toBe('QA_REMOTE_WRITE')
  expect(qaMarker(['QA_UPLOAD_GPU', 'Working folder: /tmp/qa-owned\nQA_GPU_WATCH /tmp/qa-owned'])).toBe('QA_GPU_WATCH /tmp/qa-owned')
  expect(qaMarker(['words mentioning QA_REMOTE_WRITE are not a marker line'])).toBe('')
  expect(qaMarker(['SSH target: other\nQA_REMOTE_WRITE'])).toBe('QA_REMOTE_WRITE')
})
