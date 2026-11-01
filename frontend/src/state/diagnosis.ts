/** A failed run in the person's terms: what happened, what to do next, and whether the Accounts page is where to do
 *  it. The kind is the harness's own diagnosis (`backend-ts/src/agent/diagnosis.ts`); an older run without one reads
 *  as `other` with its message. */

/** `chatgpt`: the fix is on the ChatGPT page the desktop app holds (sign in there, or open it). */
export interface Explanation { title: string; advice: string; accounts: boolean; chatgpt?: boolean }

const EXPLAIN: Record<string, Explanation> = {
  auth: { title: 'The model route refused the credentials', advice: 'The sign-in has expired or the key is wrong. Sign in again or check the key on the Accounts page, then send again.', accounts: true },
  quota: { title: "The account's quota or API credit balance is used up", advice: 'Check the account on the Accounts page. For API credits, check the provider’s balance and billing; for a subscription limit, wait for its reset. This refusal is not automatically retried. Send again after resolving it, or choose another account yourself.', accounts: true },
  rate_limit: { title: 'The provider is rate-limiting this route', advice: 'The harness already retried. Send again in a minute, or pick another model.', accounts: false },
  input_too_large: { title: 'Message is too large.', advice: '', accounts: false },
  context_overflow: { title: "The conversation no longer fits the model's window", advice: 'Start a fresh thread in this session (the workspace stays as it is) or pick a model with a larger window.', accounts: false },
  model_unavailable: { title: 'This route does not have the model', advice: 'The provider says the model is not there for this account. Pick another model.', accounts: false },
  bad_request: { title: 'The provider refused the request', advice: 'Its reason is below. Sending the same again will not change it; if it names a tool or a parameter, the harness sent something wrong.', accounts: false },
  outage: { title: 'The provider is failing', advice: 'The harness waited and retried. Try again later, or pick a model on another provider.', accounts: false },
  timeout: { title: 'The model stopped answering', advice: 'Nothing came back in time, even after the harness retried. The conversation is saved; send again.', accounts: false },
  disconnect: { title: 'The connection to the model dropped', advice: 'The harness retried and gave up. The conversation is saved; send again.', accounts: false },
  incomplete: { title: 'The answer is not complete', advice: 'Its words so far are kept below. Ask it to continue, or raise the output limit for this model.', accounts: false },
  budget: { title: 'The run reached its budget', advice: 'It stopped at the limit it was given; what it did so far is kept.', accounts: false },
  chatgpt_signin: { title: 'ChatGPT is not signed in', advice: 'Sign in on the ChatGPT page, then send again (or Continue the step).', accounts: false, chatgpt: true },
  chatgpt_unreachable: { title: "ChatGPT's page is not reachable", advice: 'ChatGPT answers through the oasis-code desktop app: open the app (and its ChatGPT page), then send again.', accounts: false },
  chatgpt_refused: { title: 'The ChatGPT page did not take the message', advice: 'Its reason is below. Look at the ChatGPT page, then send again.', accounts: false, chatgpt: true },
  other: { title: 'The run failed', advice: 'The detail below is what the harness knows.', accounts: false },
}

export function explain(kind: string | null | undefined): Explanation {
  return EXPLAIN[kind ?? ''] ?? EXPLAIN.other!
}
