/** Instructions sent to AI clients on initialize (spec §15). Routing is left to the AI. */
export const INSTRUCTIONS = `AI Foundation manages information across multiple Sources of Truth.

Task:
Executable actions.
Source of Truth: Todoist.

Schedule:
Events and time blocks tied to a specific time.
Source of Truth: Google Calendar.

Collection:
Books, games, movies and item-specific information.
Source of Truth: Notion.

Knowledge:
Reusable learning, thoughts and insights.
Source of Truth: Obsidian / Google Drive.

Project:
Project-specific information.
Source of Truth: GitHub / Google Drive.

Use the provided tools to read and modify these sources.

Do not create duplicate authoritative information across multiple sources.`;
