import { describe, it, expect } from 'vitest';
import { parseFilename, isVideo, srtToVtt, subtitleLang, splitPerformers } from '../src/parser.js';

describe('parseFilename', () => {
  it('parses scene release style', () => {
    const p = parseFilename('Brazzers.21.03.15.Riley.Reid.And.Lana.Rhoades.Hot.Night.XXX.1080p.MP4-KTR.mp4');
    expect(p.studio).toBe('Brazzers');
    expect(p.date).toBe('2021-03-15');
    expect(p.performers).toEqual(['Riley Reid', 'Lana Rhoades']);
    expect(p.title).toBe('Hot Night');
    expect(p.resolution).toBe('1080p');
    expect(p.extension).toBe('mp4');
  });
  it('parses release style with 4-digit year and no performers split', () => {
    const p = parseFilename('Vixen.2022.01.05.Some.Great.Title.2160p.mkv');
    expect(p.studio).toBe('Vixen');
    expect(p.date).toBe('2022-01-05');
    expect(p.title).toBe('Some Great Title');
    expect(p.resolution).toBe('2160p');
  });
  it('parses "Performer - [Studio.com] - Title"', () => {
    const p = parseFilename('Adria Rae - [1111Customs.com] - Cute Coed in the Bathroom.mp4');
    expect(p.studio).toBe('1111Customs');
    expect(p.performers).toEqual(['Adria Rae']);
    expect(p.title).toBe('Cute Coed in the Bathroom');
  });
  it('parses "[Studio] Performer & Performer - Title (2020)"', () => {
    const p = parseFilename('[Tushy] Emily Willis & Jane Doe - The Title (2020).mp4');
    expect(p.studio).toBe('Tushy');
    expect(p.performers).toEqual(['Emily Willis', 'Jane Doe']);
    expect(p.title).toBe('The Title');
    expect(p.year).toBe(2020);
  });
  it('parses "Studio - Performer - Title" with ISO date', () => {
    const p = parseFilename('2023-07-04 - Blacked - Jane Doe, Ann Roe - Summer Story 720p.mp4');
    expect(p.date).toBe('2023-07-04');
    expect(p.studio).toBe('Blacked');
    expect(p.performers).toEqual(['Jane Doe', 'Ann Roe']);
    expect(p.title).toBe('Summer Story');
  });
  it('parses "Performer - Studio - Title"', () => {
    const p = parseFilename('Jane Doe - Brazzers - A Long Title.mov');
    expect(p.performers).toEqual(['Jane Doe']);
    expect(p.studio).toBe('Brazzers');
    expect(p.title).toBe('A Long Title');
  });
  it('detects JAV codes', () => {
    const p = parseFilename('SSIS-123 Some Title.mp4');
    expect(p.jav).toBe('SSIS-123');
    expect(p.query).toContain('SSIS-123');
  });
  it('uses folder as studio hint', () => {
    const p = parseFilename('random clip name.webm', '/Videos/BangBros');
    expect(p.studio).toBe('BangBros');
    expect(p.title).toBe('random clip name');
  });
  it('ignores generic folder names', () => {
    expect(parseFilename('clip.mp4', '/Videos').studio).toBeNull();
  });
  it('handles underscore names', () => {
    const p = parseFilename('my_home_video_01.mp4');
    expect(p.title).toBe('my home video 01');
  });
});

describe('helpers', () => {
  it('isVideo', () => {
    expect(isVideo('a.MKV')).toBe(true);
    expect(isVideo('a.ts')).toBe(true);
    expect(isVideo('a.srt')).toBe(false);
    expect(isVideo('a-sample.mp4')).toBe(false);
  });
  it('srtToVtt', () => {
    expect(srtToVtt('1\r\n00:00:01,000 --> 00:00:02,500\r\nHi\r\n')).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHi\n');
  });
  it('subtitleLang', () => {
    expect(subtitleLang('Movie.en.srt', 'Movie')).toBe('en');
    expect(subtitleLang('Movie.srt', 'Movie')).toBeNull();
  });
  it('splitPerformers', () => {
    expect(splitPerformers('A B, C D and E F feat. G H')).toEqual(['A B', 'C D', 'E F', 'G H']);
  });
});
