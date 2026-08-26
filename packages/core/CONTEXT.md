# Core context

The core context owns the portable learning model. Local application behavior may coordinate it, but the model remains usable without the server or web packages.

## Language

**Package**:
The portable model behind courses and curricula: pinned bases, modifications, an owned patch graph, and package tags. Package is a model term, not a presented interface kind.

**Course**:
A presentation tag on a Graph set. The interface interprets the tagged set as a pedagogical work and centers the learning structure and Materials selected by that set.
_Avoid_: Domain, graph-owning model kind

**Curriculum**:
A presentation tag on a Graph set. The interface interprets the tagged set as a curriculum without giving it a distinct graph representation.
_Avoid_: Specification, synthetic course, graph-owning model kind

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
An immutable published version of a course, including its graph, Materials, and other attachments. Materials do not version independently; changing them is part of updating the course.
_Avoid_: Material version, attachment version

**Structure graph**:
The portable graph of learning nodes, relationships, and associated course Materials. Courses present structure graphs; curricula and other scopes may relate or select graphs and subgraphs without adding learner progress to them.
_Avoid_: Learner graph, progress graph

**Metadata set**:
An identified collection of properties attached to identified nodes and/or edges. Keeping metadata separate from topology allows application contexts to compose or omit properties without fabricating graph entities.

**Graph set**:
A tagged set of identified nodes, identified edges, and Metadata sets. Course and Curriculum are presentation tags on Graph sets rather than distinct graph-owning model kinds.
_Avoid_: Synthetic course, curriculum graph type
