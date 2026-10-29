/**
 * Demo seed for Margins
 * Pre-populates the database with a complete project so the demo video
 * can skip the upload/processing pipeline entirely.
 *
 * Prerequisites:
 *   docker compose up          (postgres + services running)
 *   cd frontend && npx prisma db push   (schema applied)
 *
 * Run (from the frontend directory):
 *   cd frontend && npx tsx scripts/seed-demo.ts
 */

import { PrismaClient } from '@prisma/client'

// The demo data is made up and is reached through the local-only test sign-in (DEMO.md), so it
// belongs on local databases only (this machine or docker compose).
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres'])

function assertLocalDatabase(): void {
  const raw = process.env.DATABASE_URL ?? ''
  let host = ''
  try {
    host = new URL(raw).hostname.replace(/^\[|\]$/g, '')
  } catch {
    // An unparseable URL is not provably local.
  }
  const reason =
    process.env.NODE_ENV === 'production'
      ? 'NODE_ENV is production'
      : !LOCAL_DB_HOSTS.has(host)
        ? `DATABASE_URL host "${host || '(none)'}" is not a local database`
        : ''
  if (reason) {
    console.error(
      `Refusing to seed the demo account: ${reason}. This ` +
        'script is for local development only.',
    )
    process.exit(1)
  }
}

assertLocalDatabase()

const prisma = new PrismaClient()

// ─── Entry point ────────────────────────────────────────────────

async function main() {
  console.log('Seeding Margins demo data...\n')

  // ── User ──────────────────────────────────────────────────────
  const user = await prisma.user.upsert({
    where: { email: 'demo@example.com' },
    update: {},
    create: {
      email: 'demo@example.com',
      name: 'Demo User',
    },
  })

  // ── Idempotent: drop previous demo project ──────────────────
  await prisma.project.deleteMany({
    where: { userId: user.id, name: 'CS101 Final Exam Prep' },
  })

  // ── Project ───────────────────────────────────────────────────
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: 'CS101 Final Exam Prep',
      description:
        'Study materials for the CS101 final covering data structures, algorithm analysis, and sorting.',
      status: 'active',
    },
  })

  // ── Materials (DB records; no PDF file needed for pre-seeded demo) ──
  const [matLecture, matTextbook] = await Promise.all([
    prisma.material.create({
      data: {
        projectId: project.id,
        category: 'lecture_notes',
        filename: 'cs101_lecture_notes.pdf',
        gcsPath: 'local://demo/cs101_lecture_notes.pdf',
        sizeBytes: BigInt(245760),
        validationStatus: 'valid',
        validationNotes: '24-page lecture notes — validated',
      },
    }),
    prisma.material.create({
      data: {
        projectId: project.id,
        category: 'book_chapters',
        filename: 'algorithms_textbook_ch3.pdf',
        gcsPath: 'local://demo/algorithms_textbook_ch3.pdf',
        sizeBytes: BigInt(1048576),
        validationStatus: 'valid',
        validationNotes: '32-page textbook chapter — validated',
      },
    }),
  ])

  // ── Chunks (pre-extracted text segments) ─────────────────────
  const chunkDefs = [
    { mat: matLecture.id, idx: 0, pg: [3, 5], sec: 'Lecture 3 > Arrays', text: CHUNKS.arrays },
    { mat: matLecture.id, idx: 1, pg: [6, 8], sec: 'Lecture 3 > Linked Lists', text: CHUNKS.linkedLists },
    { mat: matLecture.id, idx: 2, pg: [9, 12], sec: 'Lecture 4 > Binary Trees', text: CHUNKS.trees },
    { mat: matTextbook.id, idx: 0, pg: [1, 4], sec: 'Ch 3 > Big-O Notation', text: CHUNKS.bigO },
    { mat: matTextbook.id, idx: 1, pg: [5, 7], sec: 'Ch 3 > Analysis Techniques', text: CHUNKS.analysisTechniques },
    { mat: matTextbook.id, idx: 2, pg: [10, 12], sec: 'Ch 3 > Bubble Sort', text: CHUNKS.bubbleSort },
    { mat: matTextbook.id, idx: 3, pg: [13, 16], sec: 'Ch 3 > Merge Sort', text: CHUNKS.mergeSort },
    { mat: matTextbook.id, idx: 4, pg: [17, 20], sec: 'Ch 3 > Quick Sort', text: CHUNKS.quickSort },
  ]

  const chunks = await Promise.all(
    chunkDefs.map((d) =>
      prisma.materialChunk.create({
        data: {
          materialId: d.mat,
          chunkText: d.text,
          sectionHierarchy: d.sec,
          pageStart: d.pg[0],
          pageEnd: d.pg[1],
          chunkIndex: d.idx,
          tokenCount: Math.floor(d.text.length / 4),
        },
      })
    )
  )

  // ── Topics + chunk mappings ───────────────────────────────────
  const TOPIC_DEFS = [
    {
      name: 'Data Structures',
      desc: 'Fundamental data structures: arrays, linked lists, and BSTs — properties, trade-offs, and use cases.',
      kw: ['array', 'linked list', 'BST', 'binary tree', 'pointer', 'O(1) access'],
      chunkIdxs: [0, 1, 2],
    },
    {
      name: 'Algorithm Analysis',
      desc: 'Big-O notation and techniques for analyzing time and space complexity, including loop analysis and recursion.',
      kw: ['Big-O', 'time complexity', 'space complexity', 'dominant term', 'recursion'],
      chunkIdxs: [3, 4],
    },
    {
      name: 'Sorting Algorithms',
      desc: 'Core sorting algorithms — bubble, merge, and quick sort — their mechanics, complexity, and trade-offs.',
      kw: ['bubble sort', 'merge sort', 'quick sort', 'pivot', 'partition', 'O(n log n)'],
      chunkIdxs: [5, 6, 7],
    },
  ]

  const topics = []
  for (let i = 0; i < TOPIC_DEFS.length; i++) {
    const d = TOPIC_DEFS[i]
    const topic = await prisma.topic.create({
      data: {
        projectId: project.id,
        name: d.name,
        description: d.desc,
        keywords: d.kw,
        orderIndex: i,
        sourceMaterialIds: [],
        userConfirmed: true,
      },
    })

    for (const ci of d.chunkIdxs) {
      await prisma.topicChunkMapping.create({
        data: {
          topicId: topic.id,
          chunkId: chunks[ci].id,
          relevanceScore: 0.88 + (ci % 3) * 0.04,
          relevanceSource: 'keyword_match',
        },
      })
    }

    topics.push(topic)
  }

  // ── Pre-generated content (notes + examples + quiz per topic) ─
  for (const topic of topics) {
    await prisma.topicContent.create({
      data: {
        topicId: topic.id,
        contentType: 'section_notes',
        contentData: NOTES[topic.name] as any,
        metadata: {
          citations: [{ filename: 'cs101_lecture_notes.pdf' }],
          chunk_count: 3,
        },
      },
    })

    await prisma.topicContent.create({
      data: {
        topicId: topic.id,
        contentType: 'solved_examples',
        contentData: EXAMPLES[topic.name] as any,
        metadata: { example_type: 'solved', difficulty_level: 'medium', count: 2 },
      },
    })

    await prisma.topicContent.create({
      data: {
        topicId: topic.id,
        contentType: 'topic_quiz',
        contentData: QUIZ[topic.name] as any,
        metadata: {
          total_questions: 4,
          difficulty_level: 'medium',
          question_types: ['multiple_choice', 'true_false'],
        },
      },
    })
  }

  console.log('Done.\n')
  console.log('  Sign in: demo@example.com with the test sign-in on /login (ENABLE_TEST_LOGIN=true)')
  console.log(`  Project: "${project.name}"\n`)
}

// ─── Source-material chunks ─────────────────────────────────────

const CHUNKS = {
  arrays: `An array is a contiguous block of memory storing elements of the same type. Arrays provide O(1) access by index: address = base + (index x element_size). Trade-off: insertion/deletion in the middle requires shifting elements, giving O(n). Use arrays when random access is frequent and the size is known in advance.`,

  linkedLists: `A linked list stores elements in nodes; each node holds a value and a pointer to the next node. O(1) insertion/deletion at the head, but O(n) access by index (must traverse from head). Singly-linked lists use one pointer per node; doubly-linked lists add a previous pointer for O(1) backward traversal.`,

  trees: `A binary search tree (BST) maintains the invariant: left subtree values < node < right subtree values. Average-case search, insert, delete: O(log n). Worst case (degenerate tree): O(n). Balanced BSTs (AVL, Red-Black) guarantee O(log n) in all cases by enforcing height constraints after every operation.`,

  bigO: `Big-O notation describes the upper bound of an algorithm's growth rate as input size n grows. Common complexities: O(1) constant, O(log n) logarithmic, O(n) linear, O(n log n) linearithmic, O(n^2) quadratic, O(2^n) exponential. Drop constant factors and lower-order terms; keep only the dominant term.`,

  analysisTechniques: `To analyze an algorithm: (1) identify the dominant operation, (2) count it as a function of n, (3) simplify to Big-O. Nested loops: multiply complexities. Sequential blocks: take the max. Recursive algorithms: use the Master Theorem or draw the recursion tree. Space complexity counts extra memory used, excluding input storage.`,

  bubbleSort: `Bubble sort repeatedly steps through the list, swaps adjacent elements if out of order. After each pass the largest unsorted element reaches its final position. Time: O(n^2) average and worst case; O(n) best case with early-exit. Space: O(1), in-place. Simple to implement but slow for large inputs.`,

  mergeSort: `Merge sort divides the array in half recursively until single-element sub-arrays, then merges them in sorted order. The merge step does O(n) comparisons per level with O(log n) levels, giving O(n log n) in all cases. Space: O(n) for temporary arrays. Stable sort — preserves relative order of equal elements.`,

  quickSort: `Quick sort picks a pivot, partitions elements into < pivot and > pivot groups, then recursively sorts each partition. Average: O(n log n). Worst case: O(n^2) when pivot is always min or max, mitigated by randomized pivot selection. Space: O(log n) average. In-place and cache-friendly — often fastest in practice.`,
}

// ─── Pre-generated notes (markdown) ─────────────────────────────

const NOTES: Record<string, string> = {
  'Data Structures': `# Data Structures

## Overview
Data structures organize and store data efficiently. The right choice depends on the operations you need: access, search, insert, delete.

## Key Concepts

### Arrays
- **Access by index:** O(1) — computed directly from base address
- **Insert / Delete (middle):** O(n) — requires shifting elements
- **Best for:** fixed-size collections with frequent random access

### Linked Lists
- **Insert / Delete (head):** O(1) — just update pointers
- **Access by index:** O(n) — must traverse from head
- **Best for:** dynamic collections with frequent insertions and deletions

### Binary Search Trees (BSTs)
- **Search / Insert / Delete:** O(log n) average, O(n) worst case
- **Invariant:** left < node < right
- **Balanced variants** (AVL, Red-Black) guarantee O(log n) worst case

## Comparison Table
| Structure    | Access   | Insert     | Delete     | Space |
|--------------|----------|------------|------------|-------|
| Array        | O(1)     | O(n)       | O(n)       | O(n)  |
| Linked List  | O(n)     | O(1)*      | O(1)*      | O(n)  |
| BST          | O(log n) | O(log n)   | O(log n)   | O(n)  |

\\*at head or known position

## Summary
Choose arrays for random access, linked lists for dynamic sizing, and BSTs for ordered data with balanced search needs.

[Citation: cs101_lecture_notes.pdf, pp. 3-12]`,

  'Algorithm Analysis': `# Algorithm Analysis

## Overview
Algorithm analysis lets us predict performance without running code. Big-O notation is the standard tool.

## Key Concepts

### Big-O Notation
Describes the **upper bound** of growth rate as n grows large.

| Notation   | Name          | Example                     |
|------------|---------------|-----------------------------|
| O(1)       | Constant      | Hash-table lookup           |
| O(log n)   | Logarithmic   | Binary search               |
| O(n)       | Linear        | Single array scan           |
| O(n log n) | Linearithmic  | Merge sort                  |
| O(n^2)     | Quadratic     | Nested loops over same data |
| O(2^n)     | Exponential   | Brute-force subsets         |

**Simplification rule:** Drop constants and lower-order terms.
Example: 5n^2 + 3n + 7 simplifies to O(n^2).

### Analysis Techniques
1. **Nested loops:** multiply complexities
2. **Sequential blocks:** take the dominant one
3. **Recursion:** draw the recursion tree or apply the Master Theorem
4. **Space complexity:** count extra memory only (exclude input)

## Summary
Big-O is an asymptotic tool — it tells you how algorithms *scale*, not their exact runtime. Always identify the dominant term.

[Citation: algorithms_textbook_ch3.pdf, pp. 1-7]`,

  'Sorting Algorithms': `# Sorting Algorithms

## Overview
Sorting is one of the most fundamental operations in CS. Each algorithm trades off simplicity, speed, and memory differently.

## Key Concepts

### Bubble Sort
- Repeatedly swaps adjacent out-of-order pairs
- **Time:** O(n^2) — even in the average case
- **Space:** O(1) — in-place
- Use only for tiny arrays or nearly-sorted data

### Merge Sort
- Divide-and-conquer: split, sort halves, merge
- **Time:** O(n log n) — guaranteed in all cases
- **Space:** O(n) — needs temporary arrays
- **Stable** — equal elements keep original order
- Great for linked lists and external (disk-based) sorting

### Quick Sort
- Pick pivot, partition, recurse on each side
- **Time:** O(n log n) average; O(n^2) worst case
- **Space:** O(log n) — recursion stack only
- Fastest in practice due to cache locality
- Randomized pivot selection avoids worst case

## Comparison
| Algorithm | Best       | Average    | Worst      | Space    | Stable |
|-----------|------------|------------|------------|----------|--------|
| Bubble    | O(n)       | O(n^2)     | O(n^2)     | O(1)     | Yes    |
| Merge     | O(n log n) | O(n log n) | O(n log n) | O(n)     | Yes    |
| Quick     | O(n log n) | O(n log n) | O(n^2)     | O(log n) | No     |

## Summary
Merge sort for guaranteed performance, quick sort for real-world speed, bubble sort only for learning.

[Citation: algorithms_textbook_ch3.pdf, pp. 10-20]`,
}

// ─── Pre-generated solved examples ──────────────────────────────

const EXAMPLES: Record<string, object[]> = {
  'Data Structures': [
    {
      title: 'Comparing Array vs Linked List Insert',
      problem_statement:
        'You have 1 000 elements. Analyze the cost of inserting a new element at index 500 for both an array and a singly-linked list.',
      solution_steps: [
        {
          step_number: 1,
          description: 'Array insert at index 500',
          work: 'Shift elements [500..999] one position right — 500 moves',
          explanation:
            'Array insert requires shifting all elements after the insertion point.',
        },
        {
          step_number: 2,
          description: 'Linked list insert at index 500',
          work: 'Traverse 500 nodes to reach position, then update 2 pointers',
          explanation:
            'Linked list needs O(n) traversal but only O(1) pointer updates for the actual insert.',
        },
        {
          step_number: 3,
          description: 'Compare',
          work: 'Array: O(n) shifts. Linked list: O(n) traversal + O(1) insert.',
          explanation:
            'Both are O(n) overall, but linked list avoids moving data in memory.',
        },
      ],
      final_answer:
        'Both O(n) for insert at an arbitrary index. Array shifts data; linked list traverses pointers. For insert-heavy workloads at known positions, a linked list avoids memory moves.',
      key_concepts: [
        'Array insert',
        'Linked list traversal',
        'Time complexity comparison',
      ],
      difficulty: 'medium',
    },
    {
      title: 'BST Search Path',
      problem_statement:
        'Given a BST with root 50 and nodes [30, 70, 20, 40, 60, 80], trace the search path for value 40.',
      solution_steps: [
        {
          step_number: 1,
          description: 'Compare with root',
          work: '40 < 50 → go left',
          explanation:
            'BST invariant: values less than the root are in the left subtree.',
        },
        {
          step_number: 2,
          description: 'Compare with node 30',
          work: '40 > 30 → go right',
          explanation:
            '40 is greater than 30, so it must be in the right subtree of 30.',
        },
        {
          step_number: 3,
          description: 'Compare with node 40',
          work: '40 == 40 → found!',
          explanation: 'Target value located after 3 comparisons.',
        },
      ],
      final_answer:
        'Search path: 50 → 30 → 40. Found in 3 comparisons — O(log n) for a balanced BST with 7 nodes.',
      key_concepts: ['BST search', 'Tree traversal', 'Comparison-based search'],
      difficulty: 'easy',
    },
  ],

  'Algorithm Analysis': [
    {
      title: 'Analyzing Nested Loops',
      problem_statement:
        'Determine the Big-O complexity of:\n  for i = 1 to n:\n    for j = 1 to i:\n      print(i, j)',
      solution_steps: [
        {
          step_number: 1,
          description: 'Count inner-loop iterations',
          work: 'i=1 → 1, i=2 → 2, ..., i=n → n',
          explanation:
            'The inner loop runs i times for each value of i.',
        },
        {
          step_number: 2,
          description: 'Sum total iterations',
          work: '1 + 2 + ... + n = n(n+1)/2',
          explanation: 'Arithmetic series formula.',
        },
        {
          step_number: 3,
          description: 'Simplify to Big-O',
          work: 'n(n+1)/2 = (n^2 + n)/2 → drop constants and lower terms → O(n^2)',
          explanation:
            'The dominant term is n^2. Constants and lower-order terms are dropped.',
        },
      ],
      final_answer:
        'O(n^2). The triangular iteration pattern sums to n(n+1)/2, which is quadratic.',
      key_concepts: [
        'Nested loop analysis',
        'Arithmetic series',
        'Simplification to Big-O',
      ],
      difficulty: 'medium',
    },
    {
      title: 'Space vs Time Trade-off: Duplicate Detection',
      problem_statement:
        'A function checks if an array has duplicates. Version A uses a nested loop; Version B uses a hash set. Analyze both.',
      solution_steps: [
        {
          step_number: 1,
          description: 'Version A — nested loop',
          work: 'Two nested loops, each up to n → O(n^2) time, O(1) extra space',
          explanation:
            'Compare every pair without extra memory.',
        },
        {
          step_number: 2,
          description: 'Version B — hash set',
          work: 'One loop with O(1) set-lookup per element → O(n) time, O(n) extra space',
          explanation:
            'Store seen values in a set for constant-time duplicate checks.',
        },
        {
          step_number: 3,
          description: 'Compare trade-offs',
          work: 'A: O(n^2) time / O(1) space.  B: O(n) time / O(n) space.',
          explanation:
            'Classic time-space trade-off. Version B is faster but uses more memory.',
        },
      ],
      final_answer:
        'Version A: O(n^2) time, O(1) space. Version B: O(n) time, O(n) space. Choose B when n is large and memory is available.',
      key_concepts: [
        'Time-space trade-off',
        'Hash set',
        'Duplicate detection',
      ],
      difficulty: 'medium',
    },
  ],

  'Sorting Algorithms': [
    {
      title: 'Tracing Merge Sort',
      problem_statement:
        'Trace merge sort on [38, 27, 43, 3, 9, 82, 10]. Show the split and merge steps.',
      solution_steps: [
        {
          step_number: 1,
          description: 'Split into halves',
          work: '[38,27,43,3] and [9,82,10]',
          explanation:
            'Divide at the midpoint. Continue splitting until single elements.',
        },
        {
          step_number: 2,
          description: 'Recursively split left half',
          work: '[38,27] → [38],[27]   [43,3] → [43],[3]',
          explanation: 'Each sub-array splits until size 1.',
        },
        {
          step_number: 3,
          description: 'Merge sorted pairs (left side)',
          work: '[27,38]  [3,43] → merge → [3,27,38,43]',
          explanation:
            'Merge compares the heads of each sorted sub-array, picking the smaller.',
        },
        {
          step_number: 4,
          description: 'Sort right side and final merge',
          work: '[9,82,10] → … → [9,10,82].  Final: [3,9,10,27,38,43,82]',
          explanation: 'Same process on the right, then merge both sorted halves.',
        },
      ],
      final_answer:
        'Sorted: [3, 9, 10, 27, 38, 43, 82]. Total work ≈ n log n ≈ 20 comparisons.',
      key_concepts: ['Divide and conquer', 'Merge step', 'Recursion tree'],
      difficulty: 'medium',
    },
    {
      title: 'Quick Sort — One Partition Step',
      problem_statement:
        'Partition [10, 7, 8, 9, 1, 5] using the last element (5) as pivot. Show the result and pivot index.',
      solution_steps: [
        {
          step_number: 1,
          description: 'Set pivot and boundary',
          work: 'pivot = 5.  i = -1 (boundary of the ≤ pivot region)',
          explanation: 'The pivot will end up at its final sorted position.',
        },
        {
          step_number: 2,
          description: 'Scan and swap elements ≤ pivot',
          work: 'j=0..3: 10,7,8,9 all > 5 → skip.  j=4: 1 ≤ 5 → i=0, swap [0]↔[4] → [1,7,8,9,10,5]',
          explanation:
            'Move elements ≤ pivot to the left partition.',
        },
        {
          step_number: 3,
          description: 'Place pivot in final position',
          work: 'Swap [i+1]↔[last] → [1]↔[5] → [1,5,8,9,10,7].  Pivot index = 1',
          explanation:
            'Pivot 5 is now at index 1.  Left partition: [1].  Right partition: [8,9,10,7].',
        },
      ],
      final_answer:
        'After partition: [1, 5, 8, 9, 10, 7].  Pivot 5 is at its final sorted index (1).  Recurse on [1] and [8,9,10,7].',
      key_concepts: ['Lomuto partition', 'Pivot placement', 'Quick sort recursion'],
      difficulty: 'hard',
    },
  ],
}

// ─── Pre-generated quiz questions ───────────────────────────────

const QUIZ: Record<string, object[]> = {
  'Data Structures': [
    {
      question_type: 'multiple_choice',
      question_text:
        'What is the time complexity of accessing an element by index in an array?',
      options: [
        { id: 'A', text: 'O(n)' },
        { id: 'B', text: 'O(log n)' },
        { id: 'C', text: 'O(1)' },
        { id: 'D', text: 'O(n^2)' },
      ],
      correct_answer: 'C',
      explanation:
        'Arrays store elements contiguously. The address of any element is computed directly: base + index × element_size.',
      points: 2,
      difficulty: 'easy',
      concepts_tested: ['Array access'],
    },
    {
      question_type: 'true_false',
      question_text:
        'Inserting at the head of a singly-linked list is an O(n) operation.',
      correct_answer: false,
      explanation:
        'False. Inserting at the head only requires creating a new node and updating one pointer — O(1).',
      points: 1,
      difficulty: 'easy',
      concepts_tested: ['Linked list insert'],
    },
    {
      question_type: 'multiple_choice',
      question_text: 'A BST with n nodes has O(log n) search time when:',
      options: [
        { id: 'A', text: 'The tree is completely empty' },
        { id: 'B', text: 'The tree is balanced' },
        { id: 'C', text: 'All nodes are in the left subtree' },
        { id: 'D', text: 'n is less than 10' },
      ],
      correct_answer: 'B',
      explanation:
        'A balanced BST has height log n, so search traverses at most log n levels.',
      points: 2,
      difficulty: 'medium',
      concepts_tested: ['BST balance', 'Search complexity'],
    },
    {
      question_type: 'true_false',
      question_text:
        'A linked list uses O(1) extra space per element compared to an array.',
      correct_answer: false,
      explanation:
        'False. Each linked list node stores a pointer in addition to the value, using more space per element than a plain array.',
      points: 1,
      difficulty: 'medium',
      concepts_tested: ['Space complexity'],
    },
  ],

  'Algorithm Analysis': [
    {
      question_type: 'multiple_choice',
      question_text: 'What is the Big-O of: 7n^3 + 2n^2 + n + 100?',
      options: [
        { id: 'A', text: 'O(n^2)' },
        { id: 'B', text: 'O(n^3)' },
        { id: 'C', text: 'O(7n^3)' },
        { id: 'D', text: 'O(n^3 + n^2)' },
      ],
      correct_answer: 'B',
      explanation:
        'Drop all constants and lower-order terms. The dominant term is n^3.',
      points: 2,
      difficulty: 'easy',
      concepts_tested: ['Big-O simplification'],
    },
    {
      question_type: 'true_false',
      question_text:
        'An O(n log n) algorithm is always faster than an O(n^2) algorithm for any input size.',
      correct_answer: false,
      explanation:
        'False. For very small n the O(n^2) version may be faster due to lower constant factors. Big-O describes asymptotic behavior only.',
      points: 1,
      difficulty: 'medium',
      concepts_tested: ['Asymptotic analysis', 'Constants'],
    },
    {
      question_type: 'multiple_choice',
      question_text:
        'Two nested loops, each iterating n times, produce a time complexity of:',
      options: [
        { id: 'A', text: 'O(2n)' },
        { id: 'B', text: 'O(n)' },
        { id: 'C', text: 'O(n^2)' },
        { id: 'D', text: 'O(n + n)' },
      ],
      correct_answer: 'C',
      explanation: 'Nested loops multiply: n × n = n^2.',
      points: 2,
      difficulty: 'easy',
      concepts_tested: ['Nested loop analysis'],
    },
    {
      question_type: 'true_false',
      question_text:
        'Space complexity includes the memory used to store the input data itself.',
      correct_answer: false,
      explanation:
        'False. Space complexity measures only the extra (auxiliary) memory used beyond the input.',
      points: 1,
      difficulty: 'medium',
      concepts_tested: ['Space complexity definition'],
    },
  ],

  'Sorting Algorithms': [
    {
      question_type: 'multiple_choice',
      question_text:
        'Which sorting algorithm guarantees O(n log n) in the worst case?',
      options: [
        { id: 'A', text: 'Bubble Sort' },
        { id: 'B', text: 'Quick Sort' },
        { id: 'C', text: 'Merge Sort' },
        { id: 'D', text: 'Selection Sort' },
      ],
      correct_answer: 'C',
      explanation:
        'Merge sort always splits in half and merges in O(n) per level with O(log n) levels → O(n log n) guaranteed.',
      points: 2,
      difficulty: 'easy',
      concepts_tested: ['Sorting complexity'],
    },
    {
      question_type: 'true_false',
      question_text: 'Quick sort is a stable sorting algorithm.',
      correct_answer: false,
      explanation:
        'False. Quick sort rearranges elements around a pivot, which can change the relative order of equal elements.',
      points: 1,
      difficulty: 'medium',
      concepts_tested: ['Sort stability'],
    },
    {
      question_type: 'multiple_choice',
      question_text: 'What causes quick sort to degrade to O(n^2)?',
      options: [
        { id: 'A', text: 'The pivot is always the smallest or largest element' },
        { id: 'B', text: 'The array has all unique elements' },
        { id: 'C', text: 'The array length is a power of 2' },
        { id: 'D', text: 'The pivot is always the median' },
      ],
      correct_answer: 'A',
      explanation:
        'If the pivot is always the min or max, one partition is empty and the other has n-1 elements, giving O(n^2).',
      points: 3,
      difficulty: 'hard',
      concepts_tested: ['Quick sort worst case', 'Pivot selection'],
    },
    {
      question_type: 'true_false',
      question_text:
        'Merge sort requires O(n) extra space for temporary merge arrays.',
      correct_answer: true,
      explanation:
        'True. During the merge step elements are copied into temporary arrays, using O(n) additional space in total.',
      points: 1,
      difficulty: 'easy',
      concepts_tested: ['Merge sort space'],
    },
  ],
}

// ─── Run ────────────────────────────────────────────────────────
main().catch(console.error).finally(() => prisma.$disconnect())
