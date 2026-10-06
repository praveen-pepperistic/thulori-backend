// Photo reading. Step 1 looks at each photo (in batches) and writes one question per photo;
// step 2 reads all the descriptions together and writes questions about what recurs.
// OpenAI Responses API with image input + strict JSON schema output.
import OpenAI from 'openai';
import { config } from '../../config.js';

export interface PhotoInput { id: string; image: string /* https URL or data: URL */ }
export interface PhotoReading {
  id: string; scene: string; people: string; things: string; place: string; occasion: string | null;
  obs: string; q: string; options: string[];
}
export interface ThemeCard { photos: string[]; topic: string; obs: string; q: string; options: string[] }
export interface PhotoSummary { id: string; scene: string; people: string; things: string; place: string; occasion: string | null }

export interface PhotoReader {
  describe(child: string, photos: PhotoInput[]): Promise<PhotoReading[]>;
  themes(child: string, edition: string, photos: PhotoSummary[], skipTopics: string[], max: number): Promise<ThemeCard[]>;
}

const VOICE = `You help parents in India make a keepsake storybook about their child. Be warm, specific and brief.
Never guess anyone's name or state a relationship as fact — describe people by appearance and ask about them.
Answer options are written in the parent's voice and may use Indian family words (Amma, Appa, Paati, Thatha, Akka, Anna, Athai, Mama).`;

const readingSchema = {
  type: 'object', additionalProperties: false, required: ['photos'],
  properties: {
    photos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['n', 'scene', 'people', 'things', 'place', 'occasion', 'obs', 'q', 'options'],
        properties: {
          n: { type: 'integer', description: '1-based index of the photo in the order given' },
          scene: { type: 'string', description: 'One short sentence describing the photo' },
          people: { type: 'string' }, things: { type: 'string', description: 'Notable toys, objects, clothing, food' },
          place: { type: 'string' }, occasion: { type: ['string', 'null'] },
          obs: { type: 'string', description: 'What you notice, said to the parent, max 20 words' },
          q: { type: 'string', description: 'A question asking for the story behind this moment, max 18 words' },
          options: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
        },
      },
    },
  },
} as const;

const themeSchema = {
  type: 'object', additionalProperties: false, required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['photos', 'topic', 'obs', 'q', 'options'],
        properties: {
          photos: { type: 'array', items: { type: 'string' }, minItems: 2 },
          topic: { type: 'string' }, obs: { type: 'string' }, q: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
        },
      },
    },
  },
} as const;

class OpenAIReader implements PhotoReader {
  private client = new OpenAI({ apiKey: config().OPENAI_API_KEY });
  private async json<T>(input: any, name: string, schema: object): Promise<T> {
    const res: any = await this.client.responses.create({
      model: config().OPENAI_MODEL,
      input,
      text: { format: { type: 'json_schema', name, strict: true, schema } },
    } as any);
    const text: string = res.output_text ?? '';
    return JSON.parse(text) as T;
  }
  async describe(child: string, photos: PhotoInput[]) {
    const content: any[] = [{
      type: 'input_text',
      text: `${VOICE}\n\nHere are ${photos.length} family photos of ${child}, in order. For each photo: describe what you see, then write one question for the parent about that moment, with 3 likely answers. Use ${child}'s name.`,
    }];
    photos.forEach((p, i) => { content.push({ type: 'input_text', text: `Photo ${i + 1}:` }); content.push({ type: 'input_image', image_url: p.image, detail: 'low' }); });
    const out = await this.json<{ photos: any[] }>([{ role: 'user', content }], 'photo_readings', readingSchema);
    return out.photos.map((r, k) => {
      const p = photos[(Number(r.n) || k + 1) - 1] ?? photos[k];
      return p ? { id: p.id, scene: r.scene, people: r.people, things: r.things, place: r.place, occasion: r.occasion, obs: r.obs, q: r.q, options: r.options } : null;
    }).filter(Boolean) as PhotoReading[];
  }
  async themes(child: string, edition: string, photos: PhotoSummary[], skipTopics: string[], max: number) {
    if (photos.length < 2) return [];
    const lines = photos.map(p => `${p.id}: ${p.scene} | people: ${p.people || '-'} | things: ${p.things || '-'} | place: ${p.place || '-'}${p.occasion ? ' | occasion: ' + p.occasion : ''}`).join('\n');
    const prompt = `${VOICE}\n\nWe are making ${child}'s ${edition} storybook. Every photo already has its own question. Below is what each photo shows (id: description).\n\n${lines}\n\n` +
      `Find only what RECURS across 2 or more photos — the same person, toy, outfit, place or activity — and write one question about each recurring thing (most interesting first, up to ${max}). ` +
      `"photos" lists the ids it appears in; "obs" says what you noticed, e.g. "I noticed ${child} with a little red car in 5 photos." (max 25 words); "q" asks for the story behind it (max 18 words); 3 answer options (max 18 words each); "topic" is 2–4 words.` +
      (skipTopics.length ? ` Skip these topics, already answered: ${skipTopics.join('; ')}.` : '') + ' If nothing truly recurs, return an empty list.';
    const out = await this.json<{ cards: ThemeCard[] }>([{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], 'recurring_themes', themeSchema);
    const ids = new Set(photos.map(p => p.id));
    return out.cards.map(c => ({ ...c, photos: c.photos.filter(id => ids.has(id)) })).filter(c => c.photos.length >= 2).slice(0, max);
  }
}

/** Deterministic stand-in used in development and tests. */
export class MockReader implements PhotoReader {
  async describe(child: string, photos: PhotoInput[]) {
    return photos.map(p => ({ id: p.id, scene: 'A family photo', people: child, things: 'favourite toy', place: 'home', occasion: null,
      obs: `${child} looks so happy here.`, q: 'What’s the story behind this moment?', options: [`One of ${child}’s firsts`, 'A favourite everyday moment', 'A special visit, festival or trip'] }));
  }
  async themes(child: string, _e: string, photos: PhotoSummary[]) {
    return photos.length < 2 ? [] : [{ photos: photos.slice(0, 3).map(p => p.id), topic: 'The favourite toy', obs: `I noticed the same toy with ${child} in ${Math.min(3, photos.length)} photos.`, q: `Is it ${child}’s favourite? Is there a story behind it?`, options: ['Yes — a gift from Paati, and a bed buddy ever since', 'It goes everywhere with us', `${child} named it and talks to it every night`] }];
  }
}

let instance: PhotoReader | null = null;
export const photoReader = (): PhotoReader => (instance ??= config().AI_DRIVER === 'openai' ? new OpenAIReader() : new MockReader());
export const setPhotoReaderForTests = (r: PhotoReader) => { instance = r; };
