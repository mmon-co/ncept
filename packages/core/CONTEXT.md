# Core context

The core context owns the portable learning model. Local application behavior may coordinate it, but the model remains usable without the server or web packages.

## Language

**Course**:
A versioned portable namespace containing identified nodes, identified edges, and their Pedagogical metadata. References to contained entities are qualified by an exact Course revision.
_Avoid_: Domain, learner scope

**Curriculum**:
A Patch carrying the curriculum tag. The interface and lifecycle interpret that tag specially without giving Curriculum a distinct content representation.
_Avoid_: Course, specification, synthetic course

**Patch**:
A portable delta over exact Course or Patch revisions, containing additional, deleted, and modified nodes, edges, and Pedagogical metadata. A Curriculum is a specially tagged Patch; a user modification begins as a self-authored Patch and may later be reified as its own graph.
_Avoid_: Learner progress, mutable base Course

**Reification**:
Materializing a Patch as a self-contained graph for publication or use while retaining its bases and delta metadata. The retained derivation allows an explicit update to replay the Patch against newer bases and surface required reorganization.
_Avoid_: Flattening away provenance, automatic base update

**Curriculum draft identity**:
A user-chosen curriculum identifier interpreted only in the draft namespace. Its namespace must remain explicit in types and routes.
_Avoid_: Bare curriculum ID

**Published curriculum identity**:
An opaque course identifier for the published artifact. An exact published revision pairs that identifier with its semantic version.
_Avoid_: Domain, draft ID

**Adopted curriculum identity**:
The exact published curriculum revision installed for a learner, encoded by the existing binding identifier as `course_id@version`.
_Avoid_: Bare course ID, owned domain

**Course revision**:
A published version of a Course, including its nodes, edges, Materials, and other Pedagogical metadata. Materials do not version independently; changing them is part of updating the Course.
_Avoid_: Material version, attachment version

**Structure graph**:
The portable topology resolved from Course nodes and edges, optionally transformed by Patches. It contains no learner progress.
_Avoid_: Learner graph, progress graph

**Metadata set**:
An identified collection of properties attached to identified nodes and/or edges. Keeping metadata separate from topology allows application contexts to compose or omit properties without fabricating graph entities.

**Pedagogical metadata**:
Non-user-associated content attached to Course or Patch nodes and edges and released with that content. Materials may be Pedagogical metadata; mastery, learner Artifacts, and other progress-like data are not.
_Avoid_: Learner state, user tag

**Notebook**:
User-authored Pedagogical content for bridge nodes, one-off Lessons, and similar local additions. It may supply the owned delta of the personal scope and is not a different content representation from other authored Patches.
_Avoid_: Learner state, Artifact library
