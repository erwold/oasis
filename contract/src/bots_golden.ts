/** Golden vectors of the bots' identity: inputs and the bots the app's outline gave them, computed ONCE with the
 *  outline of commit 95dfa2f (frontend/src/state/outline.ts, before it moved here) and its ThreadTranscript turnFace
 *  composition, and frozen here as data. contract/src/bots.ts must give the same answers (backend
 *  tests/test_share_bots.test.ts; the frontend's unit tests may assert the same). Synthetic ids only. Not exported from
 *  the package root: import it as `@oasis-code/contract/bots-golden`. */

export const BOT_GOLDEN = {
 "colour": {
  "01-keycap": "hue-1",
  "02-terminal": "hue-7",
  "03-cursor": "neutral",
  "04-braces": "hue-7",
  "05-bubble": "neutral",
  "07-pixel": "hue-4",
  "08-prompt": "hue-5",
  "09-spark": "hue-0",
  "10-hex": "neutral",
  "13-puzzle": "hue-8",
  "15-rocket": "hue-11",
  "16-lens": "hue-6",
  "17-shield": "hue-7",
  "18-robot": "neutral",
  "19-chip": "neutral",
  "20-at": "hue-11",
  "21-megaphone": "hue-7",
  "22-whistle": "hue-0",
  "23-signpost": "hue-1",
  "24-badge": "hue-8",
  "25-compass": "hue-5",
  "26-crownblob": "hue-0",
  "27-crown": "hue-1",
  "28-flag": "hue-11",
  "29-lighthouse": "hue-5",
  "30-telescope": "hue-7",
  "31-pin": "hue-11",
  "32-helm": "hue-6",
  "33-bell": "hue-1",
  "director": "hue-6",
  "chatgpt": "hue-5",
  "nope": "none"
 },
 "main": {
  "ses_000000000001": "02-terminal",
  "ses_a1b2c3d4e5f6": "29-lighthouse",
  "ses_ffffffffffff": "22-whistle",
  "ses_7d3c0b9e21aa": "27-crown",
  "ses_0123456789ab": "18-robot",
  "ses_synthetic_task": "20-at"
 },
 "participants": [
  {
   "session": "ses_000000000001",
   "ordered": [
    "pa_000000000000"
   ],
   "bots": [
    [
     "pa_000000000000",
     "03-cursor"
    ]
   ]
  },
  {
   "session": "ses_000000000001",
   "ordered": [
    "pa_000000000000",
    "pa_00009e3779b1",
    "pa_00003c6ef362"
   ],
   "bots": [
    [
     "pa_000000000000",
     "03-cursor"
    ],
    [
     "pa_00009e3779b1",
     "16-lens"
    ],
    [
     "pa_00003c6ef362",
     "13-puzzle"
    ]
   ]
  },
  {
   "session": "ses_000000000001",
   "ordered": [
    "pa_000000000000",
    "pa_00009e3779b1",
    "pa_00003c6ef362",
    "pa_0000daa66d13",
    "pa_000078dde6c4",
    "pa_000017156075",
    "pa_0000b54cda26",
    "pa_0000538453d7"
   ],
   "bots": [
    [
     "pa_000000000000",
     "03-cursor"
    ],
    [
     "pa_00009e3779b1",
     "16-lens"
    ],
    [
     "pa_00003c6ef362",
     "13-puzzle"
    ],
    [
     "pa_0000daa66d13",
     "28-flag"
    ],
    [
     "pa_000078dde6c4",
     "08-prompt"
    ],
    [
     "pa_000017156075",
     "07-pixel"
    ],
    [
     "pa_0000b54cda26",
     "26-crownblob"
    ],
    [
     "pa_0000538453d7",
     "23-signpost"
    ]
   ]
  },
  {
   "session": "ses_000000000001",
   "ordered": [
    "pa_000000000000",
    "pa_00009e3779b1",
    "pa_00003c6ef362",
    "pa_0000daa66d13",
    "pa_000078dde6c4",
    "pa_000017156075",
    "pa_0000b54cda26",
    "pa_0000538453d7",
    "pa_0000f1bbcd88",
    "pa_00008ff34739",
    "pa_00002e2ac0ea",
    "pa_0000cc623a9b",
    "pa_00006a99b44c",
    "pa_000008d12dfd",
    "pa_0000a708a7ae",
    "pa_00004540215f",
    "pa_0000e3779b10",
    "pa_000081af14c1",
    "pa_00001fe68e72",
    "pa_0000be1e0823",
    "pa_00005c5581d4",
    "pa_0000fa8cfb85",
    "pa_000098c47536",
    "pa_000036fbeee7",
    "pa_0000d5336898",
    "pa_0000736ae249",
    "pa_000011a25bfa",
    "pa_0000afd9d5ab",
    "pa_00004e114f5c",
    "pa_0000ec48c90d"
   ],
   "bots": [
    [
     "pa_000000000000",
     "03-cursor"
    ],
    [
     "pa_00009e3779b1",
     "16-lens"
    ],
    [
     "pa_00003c6ef362",
     "13-puzzle"
    ],
    [
     "pa_0000daa66d13",
     "28-flag"
    ],
    [
     "pa_000078dde6c4",
     "08-prompt"
    ],
    [
     "pa_000017156075",
     "07-pixel"
    ],
    [
     "pa_0000b54cda26",
     "26-crownblob"
    ],
    [
     "pa_0000538453d7",
     "23-signpost"
    ],
    [
     "pa_0000f1bbcd88",
     "10-hex"
    ],
    [
     "pa_00008ff34739",
     "31-pin"
    ],
    [
     "pa_00002e2ac0ea",
     "29-lighthouse"
    ],
    [
     "pa_0000cc623a9b",
     "05-bubble"
    ],
    [
     "pa_00006a99b44c",
     "30-telescope"
    ],
    [
     "pa_000008d12dfd",
     "27-crown"
    ],
    [
     "pa_0000a708a7ae",
     "20-at"
    ],
    [
     "pa_00004540215f",
     "01-keycap"
    ],
    [
     "pa_0000e3779b10",
     "33-bell"
    ],
    [
     "pa_000081af14c1",
     "19-chip"
    ],
    [
     "pa_00001fe68e72",
     "21-megaphone"
    ],
    [
     "pa_0000be1e0823",
     "22-whistle"
    ],
    [
     "pa_00005c5581d4",
     "15-rocket"
    ],
    [
     "pa_0000fa8cfb85",
     "04-braces"
    ],
    [
     "pa_000098c47536",
     "17-shield"
    ],
    [
     "pa_000036fbeee7",
     "09-spark"
    ],
    [
     "pa_0000d5336898",
     "18-robot"
    ],
    [
     "pa_0000736ae249",
     "25-compass"
    ],
    [
     "pa_000011a25bfa",
     "24-badge"
    ],
    [
     "pa_0000afd9d5ab",
     "32-helm"
    ],
    [
     "pa_00004e114f5c",
     "10-hex"
    ],
    [
     "pa_0000ec48c90d",
     "02-terminal"
    ]
   ]
  },
  {
   "session": "ses_a1b2c3d4e5f6",
   "ordered": [
    "pa_000000000000"
   ],
   "bots": [
    [
     "pa_000000000000",
     "21-megaphone"
    ]
   ]
  },
  {
   "session": "ses_a1b2c3d4e5f6",
   "ordered": [
    "pa_000000000000",
    "pa_00009e3779b1",
    "pa_00003c6ef362"
   ],
   "bots": [
    [
     "pa_000000000000",
     "21-megaphone"
    ],
    [
     "pa_00009e3779b1",
     "10-hex"
    ],
    [
     "pa_00003c6ef362",
     "13-puzzle"
    ]
   ]
  },
  {
   "session": "ses_a1b2c3d4e5f6",
   "ordered": [
    "pa_000000000000",
    "pa_00009e3779b1",
    "pa_00003c6ef362",
    "pa_0000daa66d13",
    "pa_000078dde6c4",
    "pa_000017156075",
    "pa_0000b54cda26",
    "pa_0000538453d7"
   ],
   "bots": [
    [
     "pa_000000000000",
     "21-megaphone"
    ],
    [
     "pa_00009e3779b1",
     "10-hex"
    ],
    [
     "pa_00003c6ef362",
     "13-puzzle"
    ],
    [
     "pa_0000daa66d13",
     "28-flag"
    ],
    [
     "pa_000078dde6c4",
     "33-bell"
    ],
    [
     "pa_000017156075",
     "07-pixel"
    ],
    [
     "pa_0000b54cda26",
     "16-lens"
    ],
    [
     "pa_0000538453d7",
     "22-whistle"
    ]
   ]
  },
  {
   "session": "ses_a1b2c3d4e5f6",
   "ordered": [
    "pa_000000000000",
    "pa_00009e3779b1",
    "pa_00003c6ef362",
    "pa_0000daa66d13",
    "pa_000078dde6c4",
    "pa_000017156075",
    "pa_0000b54cda26",
    "pa_0000538453d7",
    "pa_0000f1bbcd88",
    "pa_00008ff34739",
    "pa_00002e2ac0ea",
    "pa_0000cc623a9b",
    "pa_00006a99b44c",
    "pa_000008d12dfd",
    "pa_0000a708a7ae",
    "pa_00004540215f",
    "pa_0000e3779b10",
    "pa_000081af14c1",
    "pa_00001fe68e72",
    "pa_0000be1e0823",
    "pa_00005c5581d4",
    "pa_0000fa8cfb85",
    "pa_000098c47536",
    "pa_000036fbeee7",
    "pa_0000d5336898",
    "pa_0000736ae249",
    "pa_000011a25bfa",
    "pa_0000afd9d5ab",
    "pa_00004e114f5c",
    "pa_0000ec48c90d"
   ],
   "bots": [
    [
     "pa_000000000000",
     "21-megaphone"
    ],
    [
     "pa_00009e3779b1",
     "10-hex"
    ],
    [
     "pa_00003c6ef362",
     "13-puzzle"
    ],
    [
     "pa_0000daa66d13",
     "28-flag"
    ],
    [
     "pa_000078dde6c4",
     "33-bell"
    ],
    [
     "pa_000017156075",
     "07-pixel"
    ],
    [
     "pa_0000b54cda26",
     "16-lens"
    ],
    [
     "pa_0000538453d7",
     "22-whistle"
    ],
    [
     "pa_0000f1bbcd88",
     "03-cursor"
    ],
    [
     "pa_00008ff34739",
     "31-pin"
    ],
    [
     "pa_00002e2ac0ea",
     "30-telescope"
    ],
    [
     "pa_0000cc623a9b",
     "05-bubble"
    ],
    [
     "pa_00006a99b44c",
     "20-at"
    ],
    [
     "pa_000008d12dfd",
     "08-prompt"
    ],
    [
     "pa_0000a708a7ae",
     "24-badge"
    ],
    [
     "pa_00004540215f",
     "01-keycap"
    ],
    [
     "pa_0000e3779b10",
     "02-terminal"
    ],
    [
     "pa_000081af14c1",
     "19-chip"
    ],
    [
     "pa_00001fe68e72",
     "09-spark"
    ],
    [
     "pa_0000be1e0823",
     "27-crown"
    ],
    [
     "pa_00005c5581d4",
     "15-rocket"
    ],
    [
     "pa_0000fa8cfb85",
     "26-crownblob"
    ],
    [
     "pa_000098c47536",
     "23-signpost"
    ],
    [
     "pa_000036fbeee7",
     "17-shield"
    ],
    [
     "pa_0000d5336898",
     "18-robot"
    ],
    [
     "pa_0000736ae249",
     "25-compass"
    ],
    [
     "pa_000011a25bfa",
     "04-braces"
    ],
    [
     "pa_0000afd9d5ab",
     "32-helm"
    ],
    [
     "pa_00004e114f5c",
     "10-hex"
    ],
    [
     "pa_0000ec48c90d",
     "02-terminal"
    ]
   ]
  },
  {
   "session": "ses_ffffffffffff",
   "ordered": [
    "pa_000000000000"
   ],
   "bots": [
    [
     "pa_000000000000",
     "21-megaphone"
    ]
   ]
  },
  {
   "session": "ses_ffffffffffff",
   "ordered": [
    "pa_000000000000",
    "pa_00009e3779b1",
    "pa_00003c6ef362"
   ],
   "bots": [
    [
     "pa_000000000000",
     "21-megaphone"
    ],
    [
     "pa_00009e3779b1",
     "10-hex"
    ],
    [
     "pa_00003c6ef362",
     "13-puzzle"
    ]
   ]
  },
  {
   "session": "ses_ffffffffffff",
   "ordered": [
    "pa_000000000000",
    "pa_00009e3779b1",
    "pa_00003c6ef362",
    "pa_0000daa66d13",
    "pa_000078dde6c4",
    "pa_000017156075",
    "pa_0000b54cda26",
    "pa_0000538453d7"
   ],
   "bots": [
    [
     "pa_000000000000",
     "21-megaphone"
    ],
    [
     "pa_00009e3779b1",
     "10-hex"
    ],
    [
     "pa_00003c6ef362",
     "13-puzzle"
    ],
    [
     "pa_0000daa66d13",
     "28-flag"
    ],
    [
     "pa_000078dde6c4",
     "08-prompt"
    ],
    [
     "pa_000017156075",
     "07-pixel"
    ],
    [
     "pa_0000b54cda26",
     "16-lens"
    ],
    [
     "pa_0000538453d7",
     "23-signpost"
    ]
   ]
  },
  {
   "session": "ses_ffffffffffff",
   "ordered": [
    "pa_000000000000",
    "pa_00009e3779b1",
    "pa_00003c6ef362",
    "pa_0000daa66d13",
    "pa_000078dde6c4",
    "pa_000017156075",
    "pa_0000b54cda26",
    "pa_0000538453d7",
    "pa_0000f1bbcd88",
    "pa_00008ff34739",
    "pa_00002e2ac0ea",
    "pa_0000cc623a9b",
    "pa_00006a99b44c",
    "pa_000008d12dfd",
    "pa_0000a708a7ae",
    "pa_00004540215f",
    "pa_0000e3779b10",
    "pa_000081af14c1",
    "pa_00001fe68e72",
    "pa_0000be1e0823",
    "pa_00005c5581d4",
    "pa_0000fa8cfb85",
    "pa_000098c47536",
    "pa_000036fbeee7",
    "pa_0000d5336898",
    "pa_0000736ae249",
    "pa_000011a25bfa",
    "pa_0000afd9d5ab",
    "pa_00004e114f5c",
    "pa_0000ec48c90d"
   ],
   "bots": [
    [
     "pa_000000000000",
     "21-megaphone"
    ],
    [
     "pa_00009e3779b1",
     "10-hex"
    ],
    [
     "pa_00003c6ef362",
     "13-puzzle"
    ],
    [
     "pa_0000daa66d13",
     "28-flag"
    ],
    [
     "pa_000078dde6c4",
     "08-prompt"
    ],
    [
     "pa_000017156075",
     "07-pixel"
    ],
    [
     "pa_0000b54cda26",
     "16-lens"
    ],
    [
     "pa_0000538453d7",
     "23-signpost"
    ],
    [
     "pa_0000f1bbcd88",
     "03-cursor"
    ],
    [
     "pa_00008ff34739",
     "31-pin"
    ],
    [
     "pa_00002e2ac0ea",
     "29-lighthouse"
    ],
    [
     "pa_0000cc623a9b",
     "05-bubble"
    ],
    [
     "pa_00006a99b44c",
     "30-telescope"
    ],
    [
     "pa_000008d12dfd",
     "27-crown"
    ],
    [
     "pa_0000a708a7ae",
     "20-at"
    ],
    [
     "pa_00004540215f",
     "01-keycap"
    ],
    [
     "pa_0000e3779b10",
     "02-terminal"
    ],
    [
     "pa_000081af14c1",
     "19-chip"
    ],
    [
     "pa_00001fe68e72",
     "09-spark"
    ],
    [
     "pa_0000be1e0823",
     "15-rocket"
    ],
    [
     "pa_00005c5581d4",
     "18-robot"
    ],
    [
     "pa_0000fa8cfb85",
     "26-crownblob"
    ],
    [
     "pa_000098c47536",
     "17-shield"
    ],
    [
     "pa_000036fbeee7",
     "33-bell"
    ],
    [
     "pa_0000d5336898",
     "25-compass"
    ],
    [
     "pa_0000736ae249",
     "32-helm"
    ],
    [
     "pa_000011a25bfa",
     "04-braces"
    ],
    [
     "pa_0000afd9d5ab",
     "24-badge"
    ],
    [
     "pa_00004e114f5c",
     "10-hex"
    ],
    [
     "pa_0000ec48c90d",
     "02-terminal"
    ]
   ]
  }
 ],
 "tables": [
  {
   "session": "ses_synthetic_task",
   "byParticipant": [
    [
     "pa_0000538453d7",
     "22-whistle"
    ],
    [
     "pa_000017156075",
     "29-lighthouse"
    ],
    [
     "pa_0000daa66d13",
     "02-terminal"
    ],
    [
     "pa_000078dde6c4",
     "03-cursor"
    ],
    [
     "pa_0000b54cda26",
     "13-puzzle"
    ]
   ],
   "byMember": [
    [
     "relay:rel_00000000000c:Z",
     "22-whistle"
    ],
    [
     "interaction:ix_00000000000b:x1",
     "29-lighthouse"
    ],
    [
     "relay:rel_00000000000a:A",
     "02-terminal"
    ],
    [
     "interaction:ix_00000000000b:A",
     "02-terminal"
    ],
    [
     "relay:rel_00000000000a:B",
     "03-cursor"
    ]
   ]
  }
 ],
 "rows": [
  {
   "row": {
    "id": "run_000000000001",
    "model": "anthropic:claude-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "human",
    "parent_run_id": null,
    "work_order": null,
    "collab": {
     "participant_id": "pa_main00000000",
     "participant_role": "main",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "bot": "20-at"
  },
  {
   "row": {
    "id": "run_000000000002",
    "model": "anthropic:claude-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "human",
    "parent_run_id": null,
    "work_order": null,
    "collab": {
     "participant_id": "pa_0000daa66d13",
     "participant_role": "participant",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "bot": "02-terminal"
  },
  {
   "row": {
    "id": "run_000000000006",
    "model": "openai:gpt-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "agent",
    "parent_run_id": "run_000000000001",
    "work_order": null,
    "collab": {
     "participant_id": "pa_0000b54cda26",
     "participant_role": "separate",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "bot": "13-puzzle"
  },
  {
   "row": {
    "id": "run_00000000000d",
    "model": "openai:gpt-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "human",
    "parent_run_id": "run_000000000001",
    "work_order": null,
    "collab": null
   },
   "bot": "28-flag"
  },
  {
   "row": {
    "id": "run_00000000000e",
    "model": "openai:gpt-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "human",
    "parent_run_id": null,
    "work_order": null,
    "collab": null
   },
   "bot": "20-at"
  },
  {
   "row": {
    "id": "run_00000000000f",
    "model": "openai:gpt-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "human",
    "parent_run_id": null,
    "work_order": {
     "label": "w"
    },
    "collab": null
   },
   "bot": "33-bell"
  },
  {
   "row": {
    "id": "run_000000000010",
    "model": "openai:gpt-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "human",
    "parent_run_id": "run_000000000001",
    "work_order": null,
    "participant_id": "rel_00000000000a:A",
    "collab": null
   },
   "bot": "31-pin"
  },
  {
   "row": {
    "id": "run_000000000011",
    "model": "chatgpt:web",
    "session_id": "ses_synthetic_task",
    "spawned_by": "human",
    "parent_run_id": null,
    "work_order": null,
    "collab": {
     "participant_id": "pa_0000daa66d13",
     "participant_role": "participant",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "bot": "chatgpt"
  },
  {
   "row": {
    "id": "run_000000000012",
    "model": null,
    "session_id": "ses_synthetic_task",
    "spawned_by": "human",
    "parent_run_id": null,
    "work_order": null,
    "collab": null
   },
   "bot": null
  },
  {
   "row": {
    "id": "run_000000000013",
    "model": "openai:gpt-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "human_action",
    "parent_run_id": null,
    "work_order": null,
    "collab": null
   },
   "bot": null
  },
  {
   "row": {
    "id": "ix_00000000000b",
    "model": "anthropic:claude-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "plan",
    "parent_run_id": null,
    "work_order": null,
    "kind": "plan",
    "collab": null
   },
   "bot": "director"
  },
  {
   "row": {
    "id": "ix_00000000000b:decide",
    "model": null,
    "session_id": "ses_synthetic_task",
    "spawned_by": "plan",
    "parent_run_id": null,
    "work_order": null,
    "kind": "decision",
    "collab": null
   },
   "bot": null
  },
  {
   "row": {
    "id": "ix_00000000000b:n2",
    "model": "openai:gpt-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "plan",
    "parent_run_id": null,
    "work_order": null,
    "kind": "run",
    "participant_id": "ix_00000000000b:x1",
    "collab": null
   },
   "bot": "28-flag"
  },
  {
   "row": {
    "id": "run_000000000014",
    "model": "openai:gpt-x",
    "session_id": "ses_synthetic_task",
    "spawned_by": "human",
    "parent_run_id": null,
    "work_order": null,
    "collab": {
     "participant_id": "pa_unknown00000",
     "participant_role": "participant",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "bot": "25-compass"
  },
  {
   "row": {
    "id": "run_000000000015",
    "model": "openai:gpt-x",
    "session_id": "ses_other0000000",
    "spawned_by": "human",
    "parent_run_id": null,
    "work_order": null,
    "collab": {
     "participant_id": "pa_main00000001",
     "participant_role": "main",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "bot": "04-braces"
  }
 ],
 "members": [
  {
   "group": {
    "kind": "relay",
    "id": "rel_00000000000a"
   },
   "alias": "A",
   "model": "m",
   "bot": "02-terminal"
  },
  {
   "group": {
    "kind": "relay",
    "id": "rel_00000000000a"
   },
   "alias": "B",
   "model": "m",
   "bot": "03-cursor"
  },
  {
   "group": {
    "kind": "interaction",
    "id": "ix_00000000000b"
   },
   "alias": "x1",
   "model": "m",
   "bot": "29-lighthouse"
  },
  {
   "group": {
    "kind": "interaction",
    "id": "ix_00000000000b"
   },
   "alias": "A",
   "model": "m",
   "bot": "02-terminal"
  },
  {
   "group": {
    "kind": "relay",
    "id": "rel_00000000000a"
   },
   "alias": "Q",
   "model": "m",
   "bot": "08-prompt"
  },
  {
   "group": {
    "kind": "interaction",
    "id": "ix_00000000000z"
   },
   "alias": "B",
   "model": "m",
   "bot": "10-hex"
  },
  {
   "group": {
    "kind": "relay",
    "id": "rel_00000000000a"
   },
   "alias": "A",
   "model": "chatgpt:web",
   "bot": "chatgpt"
  }
 ],
 "session_bots": [
  {
   "session": "ses_000000000001",
   "agents": [],
   "bots": [
    "02-terminal"
   ]
  },
  {
   "session": "ses_000000000001",
   "agents": [
    {
     "kind": "main",
     "participant_id": null,
     "model": null
    }
   ],
   "bots": [
    "02-terminal"
   ]
  },
  {
   "session": "ses_000000000001",
   "agents": [
    {
     "kind": "main",
     "participant_id": null,
     "model": null
    },
    {
     "kind": "participant",
     "participant_id": "pa_00009e3779b1",
     "model": "openai:gpt-x"
    },
    {
     "kind": "participant",
     "participant_id": "pa_00003c6ef362",
     "model": "chatgpt:web"
    },
    {
     "kind": "chatgpt",
     "participant_id": null,
     "model": null
    },
    {
     "kind": "director",
     "participant_id": null,
     "model": null
    }
   ],
   "bots": [
    "02-terminal",
    "10-hex",
    "chatgpt",
    "director"
   ]
  },
  {
   "session": "ses_000000000001",
   "agents": [
    {
     "kind": "participant",
     "participant_id": "pa_0000f1bbcd88",
     "model": "a"
    },
    {
     "kind": "participant",
     "participant_id": "pa_00008ff34739",
     "model": "b"
    },
    {
     "kind": "main",
     "participant_id": null,
     "model": null
    }
   ],
   "bots": [
    "03-cursor",
    "31-pin",
    "02-terminal"
   ]
  },
  {
   "session": "ses_a1b2c3d4e5f6",
   "agents": [],
   "bots": [
    "29-lighthouse"
   ]
  },
  {
   "session": "ses_a1b2c3d4e5f6",
   "agents": [
    {
     "kind": "main",
     "participant_id": null,
     "model": null
    }
   ],
   "bots": [
    "29-lighthouse"
   ]
  },
  {
   "session": "ses_a1b2c3d4e5f6",
   "agents": [
    {
     "kind": "main",
     "participant_id": null,
     "model": null
    },
    {
     "kind": "participant",
     "participant_id": "pa_00009e3779b1",
     "model": "openai:gpt-x"
    },
    {
     "kind": "participant",
     "participant_id": "pa_00003c6ef362",
     "model": "chatgpt:web"
    },
    {
     "kind": "chatgpt",
     "participant_id": null,
     "model": null
    },
    {
     "kind": "director",
     "participant_id": null,
     "model": null
    }
   ],
   "bots": [
    "29-lighthouse",
    "10-hex",
    "chatgpt",
    "director"
   ]
  },
  {
   "session": "ses_a1b2c3d4e5f6",
   "agents": [
    {
     "kind": "participant",
     "participant_id": "pa_0000f1bbcd88",
     "model": "a"
    },
    {
     "kind": "participant",
     "participant_id": "pa_00008ff34739",
     "model": "b"
    },
    {
     "kind": "main",
     "participant_id": null,
     "model": null
    }
   ],
   "bots": [
    "03-cursor",
    "31-pin",
    "29-lighthouse"
   ]
  },
  {
   "session": "ses_ffffffffffff",
   "agents": [],
   "bots": [
    "22-whistle"
   ]
  },
  {
   "session": "ses_ffffffffffff",
   "agents": [
    {
     "kind": "main",
     "participant_id": null,
     "model": null
    }
   ],
   "bots": [
    "22-whistle"
   ]
  },
  {
   "session": "ses_ffffffffffff",
   "agents": [
    {
     "kind": "main",
     "participant_id": null,
     "model": null
    },
    {
     "kind": "participant",
     "participant_id": "pa_00009e3779b1",
     "model": "openai:gpt-x"
    },
    {
     "kind": "participant",
     "participant_id": "pa_00003c6ef362",
     "model": "chatgpt:web"
    },
    {
     "kind": "chatgpt",
     "participant_id": null,
     "model": null
    },
    {
     "kind": "director",
     "participant_id": null,
     "model": null
    }
   ],
   "bots": [
    "22-whistle",
    "10-hex",
    "chatgpt",
    "director"
   ]
  },
  {
   "session": "ses_ffffffffffff",
   "agents": [
    {
     "kind": "participant",
     "participant_id": "pa_0000f1bbcd88",
     "model": "a"
    },
    {
     "kind": "participant",
     "participant_id": "pa_00008ff34739",
     "model": "b"
    },
    {
     "kind": "main",
     "participant_id": null,
     "model": null
    }
   ],
   "bots": [
    "03-cursor",
    "31-pin",
    "22-whistle"
   ]
  }
 ],
 "faces": [
  {
   "run": {
    "id": "run_000000000001",
    "session_id": "ses_synthetic_task",
    "model": "anthropic:claude-x",
    "spawned_by": "human",
    "parent_run_id": null,
    "collab": {
     "participant_id": "pa_main00000000",
     "participant_role": "main",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "relay": null,
   "interaction": null,
   "continues": null,
   "face": {
    "bot": "20-at",
    "enclosed": false
   }
  },
  {
   "run": {
    "id": "run_000000000002",
    "session_id": "ses_synthetic_task",
    "model": "anthropic:claude-x",
    "spawned_by": "human",
    "parent_run_id": null,
    "collab": {
     "participant_id": "pa_0000daa66d13",
     "participant_role": "participant",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "relay": {
    "relay_id": "rel_00000000000a",
    "alias": "A"
   },
   "interaction": null,
   "continues": null,
   "face": {
    "bot": "02-terminal",
    "enclosed": true
   }
  },
  {
   "run": {
    "id": "run_00000000000d",
    "session_id": "ses_synthetic_task",
    "model": "openai:gpt-x",
    "spawned_by": "human",
    "parent_run_id": "run_000000000001",
    "collab": null
   },
   "relay": {
    "relay_id": "rel_00000000000a",
    "alias": "Q"
   },
   "interaction": null,
   "continues": null,
   "face": {
    "bot": "08-prompt",
    "enclosed": true
   }
  },
  {
   "run": {
    "id": "run_00000000000e",
    "session_id": "ses_synthetic_task",
    "model": "openai:gpt-x",
    "spawned_by": "human",
    "parent_run_id": null,
    "collab": null
   },
   "relay": null,
   "interaction": {
    "interaction_id": "ix_00000000000b",
    "alias": "x1"
   },
   "continues": null,
   "face": {
    "bot": "29-lighthouse",
    "enclosed": true
   }
  },
  {
   "run": {
    "id": "run_00000000000e",
    "session_id": "ses_synthetic_task",
    "model": "openai:gpt-x",
    "spawned_by": "human",
    "parent_run_id": null,
    "collab": null
   },
   "relay": null,
   "interaction": null,
   "continues": {
    "interaction_id": "ix_00000000000z",
    "alias": "B"
   },
   "face": {
    "bot": "10-hex",
    "enclosed": true
   }
  },
  {
   "run": {
    "id": "run_000000000006",
    "session_id": "ses_synthetic_task",
    "model": "openai:gpt-x",
    "spawned_by": "agent",
    "parent_run_id": "run_000000000001",
    "collab": {
     "participant_id": "pa_0000b54cda26",
     "participant_role": "separate",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "relay": null,
   "interaction": null,
   "continues": null,
   "face": {
    "bot": "13-puzzle",
    "enclosed": true
   }
  },
  {
   "run": {
    "id": "run_00000000000d",
    "session_id": "ses_synthetic_task",
    "model": "openai:gpt-x",
    "spawned_by": "human",
    "parent_run_id": "run_000000000001",
    "collab": null
   },
   "relay": null,
   "interaction": null,
   "continues": null,
   "face": {
    "bot": "28-flag",
    "enclosed": false
   }
  },
  {
   "run": {
    "id": "run_000000000011",
    "session_id": "ses_synthetic_task",
    "model": "chatgpt:web",
    "spawned_by": "human",
    "parent_run_id": null,
    "collab": {
     "participant_id": "pa_0000daa66d13",
     "participant_role": "participant",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "relay": null,
   "interaction": null,
   "continues": null,
   "face": {
    "bot": "chatgpt",
    "enclosed": true
   }
  },
  {
   "run": {
    "id": "run_000000000014",
    "session_id": "ses_synthetic_task",
    "model": "openai:gpt-x",
    "spawned_by": "human",
    "parent_run_id": null,
    "collab": {
     "participant_id": "pa_unknown00000",
     "participant_role": "participant",
     "conversation_id": "cv",
     "conversation_seq": 0,
     "origin": {},
     "placement": {
      "surface": "thread",
      "group": null
     },
     "basis": "x"
    }
   },
   "relay": null,
   "interaction": null,
   "continues": null,
   "face": {
    "bot": "25-compass",
    "enclosed": false
   }
  }
 ],
 "identity_rows": [
  {
   "id": "run_000000000001",
   "session_id": "ses_synthetic_task",
   "created_at": "2026-10-01T00:00:01.000Z",
   "participant_alias": null,
   "participant_index": null,
   "collab": {
    "participant_id": "pa_main00000000",
    "participant_role": "main",
    "conversation_id": "cv",
    "conversation_seq": 0,
    "origin": {},
    "placement": {
     "surface": "thread",
     "group": null
    },
    "basis": "x"
   }
  },
  {
   "id": "run_000000000002",
   "session_id": "ses_synthetic_task",
   "created_at": "2026-10-01T00:00:05.000Z",
   "participant_alias": "A",
   "participant_index": 0,
   "collab": {
    "participant_id": "pa_0000daa66d13",
    "participant_role": "participant",
    "conversation_id": "cv",
    "conversation_seq": 0,
    "origin": {},
    "placement": {
     "surface": "thread",
     "group": {
      "kind": "relay",
      "id": "rel_00000000000a"
     }
    },
    "basis": "x"
   }
  },
  {
   "id": "run_000000000003",
   "session_id": "ses_synthetic_task",
   "created_at": "2026-10-01T00:00:05.000Z",
   "participant_alias": "B",
   "participant_index": 1,
   "collab": {
    "participant_id": "pa_000078dde6c4",
    "participant_role": "participant",
    "conversation_id": "cv",
    "conversation_seq": 0,
    "origin": {},
    "placement": {
     "surface": "thread",
     "group": {
      "kind": "relay",
      "id": "rel_00000000000a"
     }
    },
    "basis": "x"
   }
  },
  {
   "id": "run_000000000004",
   "session_id": "ses_synthetic_task",
   "created_at": "2026-10-01T00:00:03.000Z",
   "participant_alias": "x1",
   "participant_index": 2,
   "collab": {
    "participant_id": "pa_000017156075",
    "participant_role": "participant",
    "conversation_id": "cv",
    "conversation_seq": 0,
    "origin": {},
    "placement": {
     "surface": "thread",
     "group": {
      "kind": "interaction",
      "id": "ix_00000000000b"
     }
    },
    "basis": "x"
   }
  },
  {
   "id": "run_000000000005",
   "session_id": "ses_synthetic_task",
   "created_at": "2026-10-01T00:00:09.000Z",
   "participant_alias": "A",
   "participant_index": 0,
   "collab": {
    "participant_id": "pa_0000daa66d13",
    "participant_role": "participant",
    "conversation_id": "cv",
    "conversation_seq": 0,
    "origin": {},
    "placement": {
     "surface": "thread",
     "group": {
      "kind": "interaction",
      "id": "ix_00000000000b"
     }
    },
    "basis": "x"
   }
  },
  {
   "id": "run_000000000006",
   "session_id": "ses_synthetic_task",
   "created_at": "2026-10-01T00:00:10.000Z",
   "participant_alias": null,
   "participant_index": null,
   "collab": {
    "participant_id": "pa_0000b54cda26",
    "participant_role": "separate",
    "conversation_id": "cv",
    "conversation_seq": 0,
    "origin": {},
    "placement": {
     "surface": "thread",
     "group": null
    },
    "basis": "x"
   }
  },
  {
   "id": "run_000000000007",
   "session_id": "ses_synthetic_task",
   "created_at": "2026-10-01T00:00:00.500Z",
   "participant_alias": "Z",
   "participant_index": null,
   "collab": {
    "participant_id": "pa_0000538453d7",
    "participant_role": "participant",
    "conversation_id": "cv",
    "conversation_seq": 0,
    "origin": {},
    "placement": {
     "surface": "thread",
     "group": {
      "kind": "relay",
      "id": "rel_00000000000c"
     }
    },
    "basis": "x"
   }
  }
 ],
 "after_reset": "22-whistle"
} as const
