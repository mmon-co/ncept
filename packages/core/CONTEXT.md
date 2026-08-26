# Core context

The core context owns the portable learning model. Local application behavior may coordinate it, but the model remains usable without the server or web packages.

## Language

**Course**:
A Patch whose Patch metadata includes the course label. The application queries and presents that label specially without giving Course a distinct content representation.
_Avoid_: Domain, learner scope, graph-owning model kind

**Curriculum**:
A Patch whose Patch metadata includes the curriculum label. The application queries and presents that label specially without giving Curriculum a distinct content representation.
_Avoid_: Course, specification, synthetic course

**Patch**:
The sole identified and versioned portable content unit. A Patch names exact base Patch revisions and a delta of nodes, edges, Pedagogical metadata, and Patch metadata; a root Patch has no bases and expresses its complete graph as the delta from the empty graph.
_Avoid_: Learner progress, mutable base, separate Course model

**Reification**:
Creating a new root Patch with a new opaque identity, no bases, and the same resolved graph content as the source Patch. Citations may retain hints about the former bases and likely duplication, but those hints do not reconcile content for a user.
_Avoid_: Mutating the source Patch, automatic base update

**Patch revision**:
An exact immutable version of a Patch, including its base revision references, delta, Patch metadata, Materials, and other Pedagogical metadata. Materials do not version independently from their owning Patch.
_Avoid_: Material version, Course revision

**Patch metadata**:
Composable, queryable metadata attached to a Patch itself. Labels such as `course`, `curriculum`, and `author`, along with titles and Citations, are Patch metadata rather than hierarchy or distinct core models.
_Avoid_: Content-kind hierarchy, edit authority

**Citation**:
Inert, typed Patch metadata relating a Patch to an exact Patch revision, entity, external source, or user feedback. A Citation may describe reification, derivation, influence, or an entity mapping, but never changes graph topology or performs user-scoped reconciliation by itself.
_Avoid_: Base Patch, graph edge, Observation provenance, authoritative reconciliation

**Structure graph**:
The portable topology resolved from a Patch revision's bases and delta. It contains no learner progress.
_Avoid_: Learner graph, progress graph

**Effective node provenance**:
The exact Patch revision whose delta most recently modified a node in a resolved Structure graph. A node-scoped Lesson uses this provenance as the Patch context for its Observations.
_Avoid_: Enclosing Personal scope, mutable Patch name

**Metadata set**:
An identified collection of properties attached to an identified Patch, node, and/or edge. Keeping metadata separate from topology allows application contexts to compose or omit properties without fabricating graph entities.

**Pedagogical metadata**:
Non-user-associated content attached to Patch nodes and edges and released with that content. Materials may be Pedagogical metadata; mastery, learner Artifacts, and other progress-like data are not.
_Avoid_: Learner state, user tag

**Notebook**:
User-authored Pedagogical content for bridge nodes, one-off Lessons, and similar local additions. It is the owned delta of the Personal scope rather than a distinct content representation.
_Avoid_: Learner state, Artifact library
