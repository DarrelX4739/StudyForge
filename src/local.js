/**
 * StudyForge — on-device study engine.
 *
 * Everything here runs in the tab with no network and no API key: it turns
 * plain text into a study guide, flashcards, quiz questions and exam papers.
 * It is deliberately dependency-free and pure (no DOM), so it can be tested in
 * Node and reused by the job queue.
 *
 * Quality heuristics, not magic: it finds definition-like sentences, ranks
 * key sentences by repeated content words, and builds cloze questions from
 * them. When an AI provider is configured the app uses that instead; this is
 * the fallback that makes the app useful on day one.
 */
(function (StudyForge) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Text helpers
   * ------------------------------------------------------------------ */

  const STOPWORDS = new Set(
    ("a about above after again against all also am an and any are as at be because been before being " +
      "below between both but by can could did do does doing down during each few for from further had has " +
      "have having he her here hers herself him himself his how i if in into is it its itself just me more " +
      "most my myself no nor not now of off on once only or other our ours ourselves out over own same she " +
      "should so some such than that the their theirs them themselves then there these they this those " +
      "through to too under until up very was we were what when where which while who whom why will with " +
      "would you your yours yourself yourselves via using use used able many much may might must shall " +
      "one two three first second also however therefore thus within without across among per etc eg ie " +
      "e.g i.e example examples including include includes given like often usually generally")
      .split(/\s+/)
      .filter(Boolean),
  );

  /** Strip Markdown/HTML noise so the heuristics see plain prose. */
  function plainText(input) {
    return String(input || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^[ \t]{0,3}#{1,6}[ \t]?/gm, "")
      .replace(/[*_`~]+/g, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/\r\n?/g, "\n");
  }

  /** Strip list numbering / bullets so every sentence starts with content. */
  function stripBullets(line) {
    return String(line || "")
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "")
      .replace(/^\s*#{1,6}\s*/, "")
      .trim();
  }

  function sentences(text) {
    const out = [];
    for (const rawLine of plainText(text).split("\n")) {
      const line = stripBullets(rawLine);
      if (!line) continue;
      // A line without terminal punctuation that looks like a heading is skipped.
      if (line.length < 30 && !/[.!?]$/.test(line)) continue;
      for (const part of line.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'(])/)) {
        const sentence = part.replace(/\s+/g, " ").trim();
        if (sentence.length >= 30 && /[a-z]/i.test(sentence)) out.push(sentence);
      }
    }
    return out;
  }

  /** Content words, lightly stemmed, for keyword overlap and ranking. */
  function words(text) {
    return plainText(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .map((word) => word.replace(/^[-']+|[-']+$/g, ""))
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
      .map((word) => word.replace(/(ing|ies|ed|es|s)$/, ""));
  }

  function titleCase(term) {
    return String(term || "")
      .trim()
      .split(/\s+/)
      .map((word, index) =>
        index > 0 && STOPWORDS.has(word.toLowerCase()) && word.length < 4
          ? word.toLowerCase()
          : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join(" ");
  }

  function tidy(sentence) {
    return String(sentence || "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
  }

  /** Deterministic shuffle so regenerating the same text keeps the same set. */
  function seededShuffle(list, seed) {
    const out = list.slice();
    let value = seed || 1;
    const next = () => {
      value = (value * 1664525 + 1013904223) % 4294967296;
      return value / 4294967296;
    };
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function hash(text) {
    let value = 0;
    for (let i = 0; i < String(text).length; i += 1) {
      value = (value * 31 + String(text).charCodeAt(i)) % 2147483647;
    }
    return value || 1;
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /* ------------------------------------------------------------------ *
   * Is there enough to work with?
   * ------------------------------------------------------------------ */

  function analyse(text) {
    const clean = plainText(text);
    const list = sentences(clean);
    const wordList = words(clean);
    return {
      chars: clean.trim().length,
      words: clean.trim() ? clean.trim().split(/\s+/).length : 0,
      sentences: list,
      distinctWords: new Set(wordList).size,
    };
  }

  /** True when the text is long enough to produce something worth studying. */
  function hasUsableText(text, minimum = 180) {
    const stats = analyse(text);
    return stats.chars >= minimum && stats.distinctWords >= 12;
  }

  /* ------------------------------------------------------------------ *
   * Definitions and key sentences
   * ------------------------------------------------------------------ */

  const DEFINITION_VERBS = ["is", "are", "was", "were", "means", "refers to", "describes", "involves"];

  function cleanTerm(raw) {
    const term = String(raw || "")
      .replace(/^[-–—*•\d.)\s]+/, "")
      .replace(/[*_`"“”]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!term || term.length < 2 || term.length > 64) return "";
    if (!/[a-zA-Z]/.test(term)) return "";
    if (term.split(" ").length > 6) return "";
    if (STOPWORDS.has(term.toLowerCase())) return "";
    return term;
  }

  /**
   * Find `term → definition` pairs from bullet lists, bold labels and
   * "X is/are/means …" sentences. Ordered by first appearance, de-duplicated.
   */
  const REJECT_TERM = /\b(and|or|but|because|which|that|if|when|while|although|however)\b/i;
  const WEAK_DEFINITION = /^(?:affected|produced|released|made|used|found|known|shown|seen|given|taken|considered|called)\b/i;

  /** Rate how much a candidate looks like a real glossary entry. */
  function definitionScore(term, body) {
    let score = 0;
    if (/^(a|an|the)\b/i.test(body)) score += 2;
    if (/^(?:the\s+)?(?:process|movement|organelle|protein|pigment|type|form|state|condition|system|ability|method|theory|rule|principle|structure|substance|reaction|term|study|idea|concept)\b/i.test(body)) score += 2;
    if (/^[a-z]/.test(body)) score += 1;
    if (WEAK_DEFINITION.test(body)) score -= 3;
    if (/[,;]/.test(term)) score -= 2;
    if (term.split(/\s+/).length <= 3) score += 1;
    if (/[.!?]/.test(term)) score -= 4;
    return score;
  }

  function extractDefinitions(text) {
    const clean = plainText(text);
    const found = [];
    const seen = new Set();
    const heads = new Set();

    const push = (term, definition) => {
      const cleanTermValue = cleanTerm(term);
      const body = tidy(definition).replace(/^[-–—:]\s*/, "");
      if (!cleanTermValue || body.length < 25) return;
      if (REJECT_TERM.test(cleanTermValue)) return;
      if (/[.!?]/.test(cleanTermValue)) return;
      if (definitionScore(cleanTermValue, body) < 0) return;
      const key = cleanTermValue.toLowerCase();
      if (seen.has(key)) return;
      // One entry per head noun: "enzyme" wins over "enzyme activity".
      const head = key.split(/\s+/).pop();
      if (heads.has(head) && key.split(/\s+/).length > 1) return;
      seen.add(key);
      heads.add(key.split(/\s+/)[0]);
      found.push({ term: cleanTermValue, definition: body });
    };

    // Bulleted / headed pairs: "- Term — description", "**Term:** description",
    // "Term: description".
    for (const line of clean.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const bullet = trimmed.match(/^(?:[-*+•]|\d+[.)])\s*(.+)$/);
      const body = bullet ? bullet[1] : trimmed;
      const pair = body.match(/^([^:–—]{2,60}?)\s*(?::|–|—|\s-\s)\s*(.{25,})$/);
      if (pair) {
        push(pair[1], pair[2]);
        continue;
      }
      const verb = body.match(
        new RegExp(`^([A-Z][\\w'’\\- ]{1,48}?)\\s+(?:${DEFINITION_VERBS.join("|")})\\s+(.{25,})$`),
      );
      if (verb) push(verb[1], verb[2]);
    }

    // Inline sentences: "Photosynthesis is the process by which …".
    for (const sentence of sentences(clean)) {
      const match = sentence.match(
        new RegExp(`(?:^|[.;:]\\s+)([A-Z][\\w'’\\- ]{1,40}?)\\s+(?:${DEFINITION_VERBS.join("|")})\\s+(.{20,})$`),
      );
      if (match) push(match[1], match[2]);
    }

    return found
      .map((entry) => ({ ...entry, score: definitionScore(entry.term, entry.definition) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .sort(
        (a, b) =>
          plainText(text).toLowerCase().indexOf(a.term.toLowerCase()) -
          plainText(text).toLowerCase().indexOf(b.term.toLowerCase()),
      )
      .map(({ term, definition }) => ({ term, definition }));
  }

  /**
   * Key sentences: score each sentence by how many of its content words repeat
   * elsewhere in the text. Definitions are dropped — they already have cards.
   */
  function keySentences(text, limit = 12) {
    const list = sentences(text);
    if (!list.length) return [];
    const frequency = new Map();
    for (const sentence of list) {
      for (const word of new Set(words(sentence))) {
        frequency.set(word, (frequency.get(word) || 0) + 1);
      }
    }
    const scored = list.map((sentence, index) => {
      const unique = [...new Set(words(sentence))];
      const score = unique.reduce((total, word) => total + (frequency.get(word) || 0), 0) / Math.sqrt(unique.length || 1);
      return { sentence, index, score };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.sentence);
  }

  /* ------------------------------------------------------------------ *
   * Study guide
   * ------------------------------------------------------------------ */

  function buildStudyDocument({ name = "Study guide", subject = "", text = "" } = {}) {
    if (!hasUsableText(text)) {
      throw new Error(
        "There is not enough text here to build a study guide. Add at least a few sentences of notes.",
      );
    }
    const stats = analyse(text);
    const definitions = extractDefinitions(text);
    const key = keySentences(text, 10);
    const paragraphs = plainText(text)
      .split(/\n{2,}/)
      .map((block) =>
        block
          .split("\n")
          .map(stripBullets)
          .filter((line) => line.length > 30)
          .map((line) => tidy(line)),
      )
      .filter((block) => block.length);

    const lines = [`# ${name}`, ""];
    if (subject) lines.push(`*${subject}*`, "");

    lines.push("## Overview", "");
    lines.push(
      `${stats.words.toLocaleString()} words of source material, distilled into ${definitions.length} key term${
        definitions.length === 1 ? "" : "s"
      } and ${key.length} core idea${key.length === 1 ? "" : "s"}.`,
      "",
    );
    const definitionTerms = new Set(definitions.map((entry) => entry.term.toLowerCase()));
    const opening = stats.sentences
      .filter((sentence) => {
        const lower = sentence.toLowerCase();
        return ![...definitionTerms].some((term) => lower.startsWith(`${term}:`) || lower.startsWith(`${term} is`) || lower.startsWith(`${term} are`));
      })
      .slice(0, 2)
      .map((sentence) => tidy(sentence))
      .join(" ");
    if (opening) lines.push(opening, "");

    if (definitions.length) {
      lines.push("## Key terms", "");
      for (const entry of definitions.slice(0, 14)) {
        lines.push(`### ${titleCase(entry.term)}`, "", entry.definition, "");
      }
    }

    if (key.length) {
      lines.push("## Core ideas", "");
      for (const sentence of key) lines.push(`- ${tidy(sentence)}`);
      lines.push("");
    }

    lines.push("## Notes", "");
    for (const block of paragraphs.slice(0, 12)) {
      if (block.length === 1) lines.push(block[0], "");
      else {
        for (const line of block) lines.push(`- ${line}`);
        lines.push("");
      }
    }

    // A short self-test so the guide is active revision, not just reading.
    const cloze = buildClozeItems(text, 6);
    if (cloze.length) {
      lines.push("## Quick recall", "");
      cloze.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.prompt}`, `   - **Answer:** ${item.answer}`);
      });
      lines.push("");
    }

    lines.push("---", "");
    lines.push(
      `*Built on device by StudyForge${subject ? ` for ${subject}` : ""}. Add an AI provider in Settings for a deeper rewrite.*`,
    );
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * Cloze questions
   * ------------------------------------------------------------------ */

  /** Sentences with a useful term blanked out, used by cards and questions. */
  function buildClozeItems(text, limit = 20) {
    const definitions = extractDefinitions(text);
    const termList = definitions.map((entry) => entry.term);
    const frequency = new Map();
    for (const sentence of sentences(text)) {
      for (const word of new Set(words(sentence))) {
        frequency.set(word, (frequency.get(word) || 0) + 1);
      }
    }

    const items = [];
    const usedTerms = new Set();

    const addItem = (sentence, term) => {
      const key = term.toLowerCase();
      if (usedTerms.has(key)) return;
      const index = sentence.toLowerCase().indexOf(term.toLowerCase());
      if (index < 0) return;
      const before = sentence.slice(0, index);
      const after = sentence.slice(index + term.length);
      if (before.trim().length + after.trim().length < 25) return;
      usedTerms.add(key);
      items.push({
        sentence: tidy(sentence),
        prompt: `${tidy(before)} ______ ${tidy(after)}`.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim(),
        answer: sentence.slice(index, index + term.length),
        term,
      });
    };

    // Prefer glossary terms appearing verbatim in a sentence.
    for (const entry of definitions) {
      const sentence = sentences(text).find(
        (candidate) =>
          candidate.toLowerCase().includes(entry.term.toLowerCase()) &&
          candidate.length > entry.term.length + 40,
      );
      if (sentence) addItem(sentence, entry.term);
      if (items.length >= limit) break;
    }

    // Then blank out the most repeated multi-word-ish content word per sentence.
    if (items.length < limit) {
      for (const sentence of keySentences(text, limit * 2)) {
        const candidates = words(sentence)
          .map((word) => ({ word, count: frequency.get(word) || 0 }))
          .filter((entry) => entry.count >= 2 && entry.word.length >= 5)
          .sort((a, b) => b.count - a.count);
        if (!candidates.length) continue;
        // Recover the original casing from the sentence.
        const stem = candidates[0].word;
        const match = sentence.match(new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z]*\\b`, "i"));
        if (match) addItem(sentence, match[0]);
        if (items.length >= limit) break;
      }
    }

    return items.slice(0, limit);
  }

  /* ------------------------------------------------------------------ *
   * Flashcards
   * ------------------------------------------------------------------ */

  function buildFlashcards({ text = "", count = 20, style = "vocab" } = {}) {
    if (!hasUsableText(text)) {
      throw new Error("Add a little more text before generating flashcards.");
    }
    const total = clamp(Math.floor(count) || 20, 1, 60);
    const definitions = extractDefinitions(text);
    const cloze = buildClozeItems(text, total);
    const cards = [];
    const seen = new Set();

    const add = (front, back) => {
      const key = front.toLowerCase().trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      cards.push({ front: tidy(front), back: tidy(back), source: "" });
    };

    if (style === "question") {
      // Question cards: exam-style prompts with model answers.
      for (const item of cloze) {
        add(`Fill in the blank: “${item.prompt}”`, item.answer);
        if (cards.length >= total) break;
      }
      for (const entry of definitions) {
        if (cards.length >= total) break;
        add(`What is ${entry.term.toLowerCase()}?`, entry.definition);
      }
      for (const sentence of keySentences(text, total)) {
        if (cards.length >= total) break;
        const subjectMatch = sentence.match(/^([A-Z][\w'’\- ]{2,40}?)\s+(?:is|are|was|were|can|has|do|does)\s/i);
        if (!subjectMatch) continue;
        add(`What does the source say about ${subjectMatch[1].toLowerCase()}?`, sentence);
      }
    } else {
      // Vocabulary cards: term on the front, meaning on the back.
      for (const entry of definitions) {
        if (cards.length >= total) break;
        add(entry.term, entry.definition);
      }
      for (const item of cloze) {
        if (cards.length >= total) break;
        add(item.answer, item.sentence);
      }
    }

    // Fill any shortfall with the strongest sentences as recall prompts.
    for (const sentence of keySentences(text, total * 2)) {
      if (cards.length >= total) break;
      const match = sentence.match(/^([A-Z][\w'’\- ]{2,40}?)\s+(?:is|are|was|were|means)\s+(.{15,})$/);
      if (match) add(match[1], match[2]);
    }

    if (!cards.length) {
      throw new Error("Could not find enough distinct facts in this text. Try pasting richer notes.");
    }
    return cards.slice(0, total);
  }

  /* ------------------------------------------------------------------ *
   * Questions
   * ------------------------------------------------------------------ */

  function buildQuestions({ text = "", count = 10, style = "", sourceName = "" } = {}) {
    if (!hasUsableText(text)) {
      throw new Error("Add a little more text before generating questions.");
    }
    const total = clamp(Math.floor(count) || 10, 1, 30);
    const examOnly = style === "exam";
    const definitions = extractDefinitions(text);
    const cloze = buildClozeItems(text, total * 3);
    const questions = [];
    const seen = new Set();

    const allAnswers = [...new Set([...definitions.map((entry) => entry.term), ...cloze.map((item) => item.answer)])];
    // Distractor pool: the answers themselves plus the document's content words,
    // so a short document still yields four-choice questions.
    // Plausible nouns for distractors: words that follow a determiner, plus words
    // capitalised mid-sentence. Verbs and filler make weak wrong answers.
    const nounish = new Set();
    const plain = plainText(text);
    for (const match of plain.matchAll(/\b(?:the|a|an|of|into|from|across|inside)\s+([a-z]{4,})\b/gi)) {
      const word = match[1].toLowerCase();
      if (!STOPWORDS.has(word)) nounish.add(word);
    }
    for (const match of plain.matchAll(/(?<![.!?]\s)\b([A-Z][a-z]{3,})\b/g)) {
      nounish.add(match[1].toLowerCase());
    }
    const WEAK_DISTRACTORS = new Set([
      "process", "region", "special", "green", "movement", "action", "thing", "part", "type", "form",
      "number", "amount", "level", "system", "work", "way", "kind", "group", "place", "time", "change",
      "result", "fact", "idea", "method", "example", "case", "position", "condition", "state", "order",
    ]);
    // Skip half of a multi-word term ("Cellular" out of "Cellular respiration").
    const termHeads = new Set(
      allAnswers
        .filter((answer) => answer.includes(" "))
        .map((answer) => answer.split(/\s+/)[0].toLowerCase()),
    );
    const contentPool = [...nounish]
      .filter((word) => !WEAK_DISTRACTORS.has(word) && !termHeads.has(word))
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
    const distractorPool = [...new Set([...allAnswers, ...contentPool])];
    // One question per answer term keeps the set from asking the same fact twice.
    const usedAnswers = new Set();

    const addQuestion = (question) => {
      const key = question.question.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
      if (seen.has(key)) return;
      seen.add(key);
      questions.push(question);
    };

    const makeMcq = (item) => {
      const target = String(item.answer).toLowerCase();
      if (usedAnswers.has(target)) return null;
      const promptWords = new Set(item.prompt.toLowerCase().split(/[^a-z0-9]+/));
      const candidates = distractorPool.filter(
        (answer) =>
          answer.toLowerCase() !== target &&
          // A word already visible in the sentence would be a giveaway.
          !promptWords.has(answer.toLowerCase()),
      );
      let distractors = seededShuffle(candidates, hash(item.answer) + questions.length)
        .filter((answer) => Math.abs(answer.length - item.answer.length) < item.answer.length + 12)
        .slice(0, 3);
      if (distractors.length < 3) {
        // Loosen the length rule rather than shipping a three-option question.
        distractors = seededShuffle(candidates, hash(item.answer) + questions.length)
          .filter((answer) => !distractors.includes(answer))
          .slice(0, 3 - distractors.length)
          .concat(distractors);
      }
      if (distractors.length < 2) return null;
      usedAnswers.add(target);
      const options = seededShuffle([item.answer, ...distractors], hash(item.prompt)).map(
        (option) => option.charAt(0).toUpperCase() + option.slice(1),
      );
      return {
        type: "mcq",
        question: `Which term completes this statement? “${item.prompt}”`,
        options,
        answerIndex: options.findIndex(
          (option) => option.toLowerCase() === String(item.answer).toLowerCase(),
        ),
        answer: "",
        explanation: item.sentence,
      };
    };

    // Multiple choice first — roughly 60% of the set, all of it for exams.
    const mcqTarget = examOnly ? total : Math.max(1, Math.round(total * 0.6));
    for (const item of cloze) {
      if (questions.length >= mcqTarget) break;
      const mcq = makeMcq(item);
      if (mcq && mcq.answerIndex >= 0) addQuestion(mcq);
    }
    // Definition-style MCQs: "Which description matches <term>?"
    if (questions.length < mcqTarget && definitions.length >= 3) {
      for (const entry of definitions) {
        if (questions.length >= mcqTarget) break;
        const wrong = seededShuffle(
          definitions.filter((other) => other.term !== entry.term),
          hash(entry.term) + 7,
        ).slice(0, 3);
        if (wrong.length < 2) continue;
        const options = seededShuffle(
          [entry.definition, ...wrong.map((other) => other.definition)],
          hash(entry.definition),
        );
        addQuestion({
          type: "mcq",
          question: `Which statement best describes “${entry.term}”?`,
          options,
          answerIndex: options.indexOf(entry.definition),
          answer: "",
          explanation: `${entry.term}: ${entry.definition}`,
        });
      }
    }

    // Short answers for the rest. A term already tested by an MCQ is held back
    // so the set does not ask the same fact twice — it is only reused at the end
    // if there is not enough distinct material for the requested count.
    if (!examOnly) {
      const deferred = [];
      const offer = (question, answer) => {
        if (usedAnswers.has(answer)) deferred.push({ question, used: answer });
        else {
          usedAnswers.add(answer);
          addQuestion(question);
        }
      };

      for (const entry of definitions) {
        if (questions.length >= total) break;
        offer(
          {
            type: "short",
            question: `Explain “${entry.term}” in your own words.`,
            options: [],
            answerIndex: 0,
            answer: entry.definition,
            explanation: entry.term,
          },
          entry.term.toLowerCase(),
        );
      }
      for (const item of cloze) {
        if (questions.length >= total) break;
        offer(
          {
            type: "short",
            question: "Complete the idea: " + item.prompt,
            options: [],
            answerIndex: 0,
            answer: item.answer,
            explanation: item.sentence,
          },
          String(item.answer).toLowerCase(),
        );
      }
      for (const sentence of keySentences(text, total)) {
        if (questions.length >= total) break;
        const subject = sentence.match(/^([A-Z][\w'’\- ]{2,40}?)\s+(?:is|are|was|were|can|has|does)\s/i);
        if (!subject) continue;
        offer(
          {
            type: "short",
            question: `What does the material say about ${subject[1].toLowerCase()}?`,
            options: [],
            answerIndex: 0,
            answer: sentence,
            explanation: "",
          },
          subject[1].toLowerCase(),
        );
      }

      for (const entry of deferred) {
        if (questions.length >= total) break;
        addQuestion(entry.question);
      }
    }

    if (!questions.length) {
      throw new Error(
        "Could not build questions from this text. Try notes with more complete sentences, or connect an AI provider.",
      );
    }
    // Interleave so a set is not all one format.
    const mcqs = questions.filter((question) => question.type === "mcq");
    const shorts = questions.filter((question) => question.type === "short");
    const mixed = [];
    while (mcqs.length || shorts.length) {
      if (mcqs.length) mixed.push(mcqs.shift());
      if (mcqs.length && shorts.length && mixed.length % 3 === 1) continue;
      if (shorts.length) mixed.push(shorts.shift());
    }
    return mixed.slice(0, total);
  }

  function buildExam({ text = "", count = 15 } = {}) {
    return buildQuestions({ text, count, style: "exam" });
  }

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */

  StudyForge.local = {
    plainText,
    sentences,
    words,
    analyse,
    hasUsableText,
    extractDefinitions,
    keySentences,
    buildClozeItems,
    buildStudyDocument,
    buildFlashcards,
    buildQuestions,
    buildExam,
  };
})((window.StudyForge = window.StudyForge || {}));
