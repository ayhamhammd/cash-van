import {
  DEFAULT_PERSONA,
  PERSONAS,
  PERSONA_TOOLS,
  isPersona,
  personaPrompt,
  toolsFor,
} from './personas';
import { AGENT_TOOL_DEFS } from './tools/tool-definitions';

// The REAL definitions, not a hand-kept copy. A fixture drifts the moment a
// tool is added and then quietly stops testing the thing it exists to test.
const ALL_TOOLS = AGENT_TOOL_DEFS;

describe('isPersona', () => {
  it('accepts the four known personas', () => {
    for (const p of PERSONAS) expect(isPersona(p)).toBe(true);
  });

  it('rejects anything else, including near misses from a client', () => {
    expect(isPersona('manager')).toBe(false);
    expect(isPersona('ADMIN')).toBe(false);
    expect(isPersona('')).toBe(false);
    expect(isPersona(null)).toBe(false);
    expect(isPersona(undefined)).toBe(false);
    expect(isPersona(7)).toBe(false);
  });
});

describe('toolsFor', () => {
  it('gives the analyst reporting but not the specialist tools', () => {
    const names = toolsFor('analyst', ALL_TOOLS).map((t) => t.name);
    expect(names).toContain('generate_report');
    expect(names).not.toContain('run_checks');
    expect(names).not.toContain('get_geo');
  });

  it('gives run_python to the analyst and nobody else — it is the only persona that computes', () => {
    for (const p of PERSONAS) {
      const has = toolsFor(p, ALL_TOOLS).some((t) => t.name === 'run_python');
      expect(has).toBe(p === 'analyst');
    }
  });

  it('gives run_checks to the auditor and nobody else', () => {
    for (const p of PERSONAS) {
      const has = toolsFor(p, ALL_TOOLS).some((t) => t.name === 'run_checks');
      expect(has).toBe(p === 'auditor');
    }
  });

  it('gives get_geo to the sales coach and nobody else', () => {
    for (const p of PERSONAS) {
      const has = toolsFor(p, ALL_TOOLS).some((t) => t.name === 'get_geo');
      expect(has).toBe(p === 'sales');
    }
  });

  it('never grants a persona a tool that does not exist', () => {
    for (const p of PERSONAS) {
      for (const name of PERSONA_TOOLS[p]) {
        expect(ALL_TOOLS.some((t) => t.name === name)).toBe(true);
      }
    }
  });

  it('gives every persona a way to read the schema and query — an expert with no data is a chatbot', () => {
    for (const p of PERSONAS) {
      const names = toolsFor(p, ALL_TOOLS).map((t) => t.name);
      expect(names).toContain('get_schema');
      expect(names).toContain('run_sql');
    }
  });
});

describe('personaPrompt', () => {
  it('tells every persona it cannot write', () => {
    for (const p of PERSONAS) {
      expect(personaPrompt(p)).toContain('READ-ONLY');
    }
  });

  it('warns every persona that field-entered text is data, not instructions', () => {
    for (const p of PERSONAS) {
      expect(personaPrompt(p).toLowerCase()).toContain('ignore the');
    }
  });

  it('tells the cash admin that a zero credit limit is not enforced', () => {
    expect(personaPrompt('admin')).toContain('NOT ENFORCED');
  });

  it('tells the auditor to run the battery before speculating', () => {
    expect(personaPrompt('auditor')).toContain('run_checks');
  });

  it('is distinct per persona', () => {
    const prompts = PERSONAS.map((p) => personaPrompt(p));
    expect(new Set(prompts).size).toBe(PERSONAS.length);
  });
});

describe('DEFAULT_PERSONA', () => {
  it('is a real persona', () => {
    expect(isPersona(DEFAULT_PERSONA)).toBe(true);
  });
});
