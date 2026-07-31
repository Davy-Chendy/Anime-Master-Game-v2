# Delta: Question Set Storage

**Change ID:** `add-question-set-manifest-v2`  
**Affects:** D1 question-set persistence, Room Authority final projection, cleanup, quota model

## ADDED

### Requirement: Versioned Single-Row Question Manifest

Every newly created question set stores its bounded list of at most 30 questions in one versioned D1 manifest. Each question has a stable ID before persistence.

#### Scenario: Create a new set
- GIVEN a valid upload containing one to 30 questions
- WHEN the presenter creates the question set
- THEN D1 inserts one `question_sets` row containing the manifest and inserts no `questions` rows

#### Scenario: Read a manifest set
- GIVEN a supported non-null manifest
- WHEN any detail, start, recovery, community, or result path loads the set
- THEN it returns the same `QuestionSet` and ordered `Question[]` contract as normalized storage

#### Scenario: Reject corrupt manifest
- GIVEN a row declares manifest storage but its JSON or version is invalid
- WHEN the set is loaded
- THEN the Worker reports a structured storage error and does not silently return an empty set or legacy rows

### Requirement: Legacy Read Compatibility

Rows without a manifest continue to read ordered questions from the normalized `questions` table without a bulk backfill.

#### Scenario: Use an old public set
- GIVEN a legacy public question set
- WHEN a player opens it or starts a game
- THEN all existing questions and labels remain available with unchanged behavior

### Requirement: Dirty Label Projection

Room Authority persists only labels that changed during the game. Manifest changes use optimistic revision control and legacy changes update only dirty rows.

#### Scenario: No label change
- GIVEN a game completes without adding a correct-answer label
- WHEN final projection runs
- THEN it performs no question or manifest label write

#### Scenario: Several manifest labels change
- GIVEN several previously unlabeled questions receive labels in one game
- WHEN final projection runs
- THEN it merges them into the latest manifest with at most one successful manifest row update

#### Scenario: Concurrent rooms change different questions
- GIVEN two rooms started from the same manifest revision
- WHEN each room adds a label to a different question
- THEN revision retry merges both labels without either update being lost

#### Scenario: Concurrent conflict on one question
- GIVEN a label is already persisted for a question
- WHEN another room projects a different label for that question
- THEN the stored label is not silently overwritten and the conflict is recorded as a non-retryable projection outcome

### Requirement: Indexed Dual-Format Cleanup

Daily cleanup identifies old unreferenced private sets through targeted indexes and protects R2 images referenced by either normalized or manifest sets.

#### Scenario: Clean mixed storage
- GIVEN expired private sets in both storage formats
- WHEN cleanup runs
- THEN it extracts every candidate image, preserves shared references, deletes only safe objects, and removes only still-unreferenced sets

## MODIFIED

### Requirement: Public Catalog Indexing

Public catalog ordering indexes contain only public rows; private rows use a dedicated cleanup index.

#### Scenario: Create private then publish
- GIVEN a new private question set
- WHEN it is created and later published
- THEN creation does not populate public catalog indexes and publication makes it queryable in every existing catalog sort

## REMOVED

(None)
