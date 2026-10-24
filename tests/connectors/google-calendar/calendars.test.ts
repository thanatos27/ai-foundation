import { describe, expect, it } from 'vitest';
import { WritableCalendars } from '../../../src/connectors/google-calendar/calendars.js';
import { ConfigurationError, InputValidationError } from '../../../src/errors.js';

const PERSONAL = 'a@group.calendar.google.com';
const EVENTS = 'b@group.calendar.google.com';
const calendars = () => new WritableCalendars({ personal: PERSONAL, events: EVENTS }, 'personal');

describe('WritableCalendars', () => {
  it('uses the default calendar when none is given', () => {
    expect(calendars().forCreate(undefined)).toEqual({ alias: 'personal', calendarId: PERSONAL });
  });

  it('resolves a configured alias', () => {
    expect(calendars().forCreate('events')).toEqual({ alias: 'events', calendarId: EVENTS });
  });

  it.each(['unknown', PERSONAL, 'primary'])('rejects %s as a write target, listing aliases only', (alias) => {
    const call = () => calendars().forCreate(alias);
    expect(call).toThrow(InputValidationError);
    expect(call).toThrow('personal, events');
    try {
      call();
    } catch (error) {
      expect((error as Error).message).not.toContain(EVENTS);
    }
  });

  it('needs at least one configured calendar', () => {
    const none = new WritableCalendars(undefined, undefined);
    expect(() => none.forCreate(undefined)).toThrow(ConfigurationError);
    expect(() => none.forCreate('personal')).toThrow('writable_calendars');
    expect(() => none.requireConfigured('schedule_update')).toThrow('schedule_update');
  });

  it('finds the alias of a writable calendar ID only', () => {
    expect(calendars().aliasOf(EVENTS)).toBe('events');
    expect(calendars().aliasOf('other@example.com')).toBeUndefined();
    expect(calendars().aliasOf('events')).toBeUndefined();
  });

  it('resolves an alias for listing, and takes anything else as a calendar ID', () => {
    expect(calendars().resolveForList('events')).toBe(EVENTS);
    expect(calendars().resolveForList('other@example.com')).toBe('other@example.com');
  });

  it('labels writable calendars by alias and others by ID', () => {
    expect(calendars().label(PERSONAL)).toBe('personal');
    expect(calendars().label('other@example.com')).toBe('other@example.com');
  });
});
