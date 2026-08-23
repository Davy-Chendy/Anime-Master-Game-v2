# Delta: Presenter Early Round End

**Change ID:** `add-presenter-early-round-end`  
**Affects:** personal round authority, realtime snapshots, game controls

## ADDED

### Requirement: Presenter-controlled early personal-round end

While a personal answer deadline is open, the current presenter may explicitly end that round early. Room DO closes the authoritative deadline and marks every still-eligible player without a current-round action as automatically forfeited.

#### Scenario: End an open round early
- GIVEN a personal-mode round has an open authoritative deadline
- AND one or more eligible players have not acted
- WHEN the current presenter confirms the current question and reveal round should end
- THEN Room DO preserves all submitted and judged answers
- AND adds one automatic forfeit for each missing eligible player
- AND clears the deadline without advancing the reveal round or question

#### Scenario: Preserve pending judgement
- GIVEN an answer is pending judgement and another player has not acted
- WHEN the presenter ends the round early
- THEN the pending answer remains judgeable after its existing stability window
- AND the round cannot advance until existing manual settlement requirements are met

### Requirement: Recoverable early-end explanation

The current round snapshot records that the presenter ended the round early until the game leaves that round. Every role can explain the sudden deadline close, including after refresh or reconnect.

#### Scenario: Reconnect after early end
- GIVEN the presenter ended the current round early and the boundary was checkpointed
- WHEN a client reconnects before the next round begins
- THEN its bootstrap snapshot shows the current round as presenter-ended
- AND any automatic forfeit remains visible

## MODIFIED

### Requirement: Personal answer deadline authority

Player answers, forfeits and forfeit cancellation are accepted only while the matching Room DO round deadline remains open. Natural expiry and presenter early end share the same missing-player forfeit semantics. Only manual presenter settlement may advance to another reveal round or review, except the existing first-correct behavior.

#### Scenario: Reject a late action
- GIVEN Room DO has naturally or manually closed the current round deadline
- WHEN a player action for that question and reveal round is processed later
- THEN it is rejected without replacing an automatic forfeit or reopening the round

#### Scenario: Race with deadline Alarm
- GIVEN the presenter request and the deadline Alarm race for the same round
- WHEN Room DO serializes both events
- THEN exactly one close transition applies
- AND the later event is a no-op or terminal stale rejection

## REMOVED

(None)

