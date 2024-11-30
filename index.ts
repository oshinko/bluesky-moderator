import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import cookieParser from 'cookie-parser';
import express, { Request, Response } from 'express';

const SESSION_DIR = 'data/sessions';
const SOCIAL_FILENAME = 'social.json';
const CONFIG_FILENAME = 'config.json';
const STATE_FILENAME = 'state.json';
const LOGS_FILENAME = 'logs.jsonl';

const DEFAULT_SESSION_AGE = 3 * 24 * 60 * 60 * 1000;    // 3d
const DEFAULT_SOCIAL_SESSION_AGE = 1 * 60 * 60 * 1000;  // 1h
const DEFAULT_JUDGE_FREQUENCY = 1 * 60 * 60 * 1000;     // 1h

async function loadJson(file: string) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
  }
  if (text) return JSON.parse(text);
}

async function dumpJson(data: any, file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

if (
  !process.env.SALT || !process.env.DEFAULT_INSTRUCTION_PROMPT_FILE ||
  !process.env.DEFAULT_USER_PROMPT_FILE
) {
  console.error('Missing required environment variable');
  process.exit(1);
}
const salt = process.env.SALT;
const sessionAge = Number(process.env.SESSION_AGE || DEFAULT_SESSION_AGE);
const socialSessionAge =
  Number(process.env.SOCIAL_SESSION_AGE || DEFAULT_SOCIAL_SESSION_AGE);
const judgeFrequency =
  Number(process.env.JUDGE_FREQUENCY || DEFAULT_JUDGE_FREQUENCY);
const defaultInstructionPrompt =
  fsSync.readFileSync(process.env.DEFAULT_INSTRUCTION_PROMPT_FILE, 'utf8');
const defaultUserPrompt =
  fsSync.readFileSync(process.env.DEFAULT_USER_PROMPT_FILE, 'utf8');
const logFormat = (process.env.LOG_FORMAT ?? '').toLowerCase();

if (logFormat && logFormat !== 'false' && logFormat !== 'off') {
  function _log(builtin: Function, message?: any, ...optionalParams: any[]) {
    const time = new Date();
    const millis = ('00' + time.getMilliseconds()).slice(-3);
    builtin(`[${time.toLocaleString()}.${millis}]`, message, ...optionalParams);
  }

  const builtinConsole = { ...console };

  console.log = (message?: any, ...optionalParams: any[]) =>
    _log(builtinConsole.log, message, ...optionalParams);

  console.debug = (message?: any, ...optionalParams: any[]) =>
    _log(builtinConsole.debug, message, ...optionalParams);

  console.info = (message?: any, ...optionalParams: any[]) =>
    _log(builtinConsole.info, message, ...optionalParams);

  console.warn = (message?: any, ...optionalParams: any[]) =>
    _log(builtinConsole.warn, message, ...optionalParams);

  console.error = (message?: any, ...optionalParams: any[]) =>
    _log(builtinConsole.error, message, ...optionalParams);
}

interface JudgedPost {
  uri: string
  cause: string
}

class JudgeTools {
  social: any;
  logs: any;

  constructor({ social, logs }: any) {
    this.social = social;
    this.logs = logs;
  }

  async report(posts: JudgedPost[]) {
    console.debug(`JudgeTools.report(${JSON.stringify(posts)})`);
    for (const post of posts) {
      await this.logs.append({
        type: 'report',
        ...post,
        createdAt: new Date()
      });
    }
    await this.logs.trim();
  }

  async delete(posts: JudgedPost[]) {
    console.debug(`JudgeTools.delete(${JSON.stringify(posts)})`);
    for (const post of posts) {
      const [repo, collection, rkey] =
        post.uri.replace(/^at:\/\//, '').split('/');
      const resp = await fetch(
        this.social.provider + '/xrpc/com.atproto.repo.deleteRecord',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + this.social.session.accessJwt,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            repo,
            collection,
            rkey
          })
        }
      );
      if (!resp.ok) {
        const { error, message } = await resp.json();
        throw new Error(error + ': ' + message);
      }
      await this.logs.append({
        type: 'delete',
        ...post,
        createdAt: new Date()
      });
    }
    await this.logs.trim();
  }
}

async function judgeUsingChatCompletions({ config, social, logs, post }: any) {
  const postJson = JSON.stringify(post, null, 2);
  const resp = await fetch(config.genai.chatCompletionsApiEndpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.genai.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.genai.model,
      messages: [
        {
          role: 'system',
          content: config.instructionPrompt || defaultInstructionPrompt
        },
        {
          role: 'user',
          content: defaultUserPrompt.replace('{json}', postJson)
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'delete',
            description: 'Delete the post',
            parameters: {
              type: 'object',
              description: 'Target post',
              properties: {
                uri: {
                  type: 'string',
                  description: 'URI of the post'
                },
                cause: {
                  type: 'string',
                  description: 'Cause of the target'
                }
              },
              required: ['uri', 'cause'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'report',
            description: 'Report the post',
            parameters: {
              type: 'object',
              description: 'Target post',
              properties: {
                uri: {
                  type: 'string',
                  description: 'URI of the post'
                },
                cause: {
                  type: 'string',
                  description: 'Cause of the target'
                }
              },
              required: ['uri', 'cause'],
              additionalProperties: false
            }
          }
        }
      ]
    })
  });

  if (!resp.ok) throw new Error(JSON.stringify(await resp.json()));

  const data = await resp.json();
  console.debug(JSON.stringify(data, null, 2));

  const { message } = data.choices[0];
  const judgeTools = new JudgeTools({ social, logs });

  for (const tool of message.tool_calls ?? []) {
    if (tool.type !== 'function') continue;
    const func =
      tool.function.name === 'delete' ? judgeTools.delete : judgeTools.report;
    const judgedPosts = JSON.parse(tool.function.arguments);
    await func([judgedPosts]);
  }
}

async function judgeUsingModerations({ config, social, logs, post }: any) {
  const postJson = JSON.stringify(post, null, 2);
  const resp = await fetch(config.genai.chatCompletionsApiEndpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.genai.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.genai.model,  // omni-moderation-latest, etc.
      input: postJson
    })
  });

  if (!resp.ok) throw new Error(JSON.stringify(await resp.json()));

  const data = await resp.json();
  console.debug(JSON.stringify(data, null, 2));

  const result = data.results[0];
  if (!result.flagged) return;

  const cause = JSON.stringify({
    categorie: result.categories,
    category_scores: result.category_scores
  });
  await new JudgeTools({ social, logs }).delete([{ uri: post.uri, cause }]);
}

async function judge({ social, config, logs, post }: any) {
  return await (
    config.genai.chatCompletionsApiEndpoint.includes('/moderations') ?
      judgeUsingModerations :
      judgeUsingChatCompletions
  )({ social, config, logs, post});
}

const socialFileFormat = SESSION_DIR + '/{session}/' + SOCIAL_FILENAME;
const configFileFormat = SESSION_DIR + '/{session}/' + CONFIG_FILENAME;
const stateFileFormat = SESSION_DIR + '/{session}/' + STATE_FILENAME;
const logsFileFormat = SESSION_DIR + '/{session}/' + LOGS_FILENAME;

class Logs {
  file: string;
  maxRecords: number;

  constructor(file: string, options: any = { maxRecords: 1024 }) {
    this.file = file;
    this.maxRecords = options.maxRecords;
  }

  private async *readRaw() {
    let filehandle;
    try {
      filehandle = await fs.open(this.file);
      for await (const line of filehandle.readLines()) {
        yield line;
      }
    } catch (e) {
      if (
        !(e instanceof Error) ||
        !e.message.includes('no such file or directory')
      ) throw e;
    } finally {
      await filehandle?.close();
    }
  }

  async *read() {
    for await (const line of this.readRaw()) {
      yield JSON.parse(line);
    }
  }

  private async appendRaw(line: string) {
    await fs.appendFile(this.file, line + '\n');
  }

  async append(record: any) {
    await this.appendRaw(JSON.stringify(record));
  }

  async trim() {
    let lines: string[] = [];
    for await (const line of this.readRaw()) {
      lines.push(line);
      lines = lines.slice(-this.maxRecords);
    }
    for (const line of lines) await this.appendRaw(line);
  }
}

async function *iterSessionDir() {
  const dir = await fs.opendir(SESSION_DIR);
  for await (const dirent of dir) {
    if (!dirent.isDirectory()) continue;
    const socialFile = socialFileFormat.replace(/{session}/g, dirent.name);
    const configFile = configFileFormat.replace(/{session}/g, dirent.name);
    const stateFile = stateFileFormat.replace(/{session}/g, dirent.name);
    const logsFile = logsFileFormat.replace(/{session}/g, dirent.name);
    yield {
      session: dirent.name,
      social: {
        file: socialFile,
        data: await loadJson(socialFile)
      },
      config: {
        file: configFile,
        data: await loadJson(configFile)
      },
      state: {
        file: stateFile,
        data: await loadJson(stateFile) ?? {}
      },
      logs: new Logs(logsFile)
    };
  }
}

const app = express();
app.set('view engine', 'ejs');
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

app.get('/', async (req: Request, res: Response) => {
  if (req.cookies.session) {
    res.status(303).location('/dashboard').end();
    return;
  }
  res.render('index', { loggedOut: true });
});

app.post('/', async (req, res) => {
  const { provider, username: identifier, password } = req.body;
  const createSessionResp = await fetch(
    provider + '/xrpc/com.atproto.server.createSession',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    }
  );
  const session = await createSessionResp.json();
  console.debug('Created session', session);

  const getProfileResp = await fetch(
    provider + '/xrpc/app.bsky.actor.getProfile?actor=' + session.did,
    {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + session.accessJwt }
    }
  );
  const profile = await getProfileResp.json();
  console.debug('Got profile', profile);

  const social = {
    provider,
    session,
    profile,
    lastSessionUpdated: new Date()
  };

  const sessionKey = crypto.createHash('sha256')
    .update(session.did)
    .update(salt)
    .digest('base64url');
  const socialFile = socialFileFormat.replace(/{session}/g, sessionKey);
  await dumpJson(social, socialFile);

  res
    .status(303)
    .cookie('session', sessionKey, {
      httpOnly: true,
      maxAge: sessionAge,
      sameSite: 'lax'
    })
    .location('/')
    .end();
});

app.get('/logout', async (req, res) => {
  res.status(303).location('/').clearCookie('session').end();
});

app.get('/dashboard', async (req, res) => {
  if (!req.cookies.session) {
    res.status(303).location('/').end();
    return;
  }
  const social = await loadJson(
    socialFileFormat.replace(/{session}/g, req.cookies.session));
  const config = await loadJson(
    configFileFormat.replace(/{session}/g, req.cookies.session));
  const state = await loadJson(
    stateFileFormat.replace(/{session}/g, req.cookies.session));
  if (state?.judgeSince) state.judgeSince = new Date(state.judgeSince);
  const logs = new Logs(logsFileFormat.replace(/{session}/g, req.cookies.session));
  const logRecordLines = [];
  for await (const record of logs.read()) {
    logRecordLines.push(JSON.stringify(record));
  }
  res.render('dashboard', {
    defaultInstructionPrompt,
    social,
    config,
    state,
    logs: logRecordLines.join('\n')
  });
});

app.post('/dashboard', async (req, res) => {
  if (!req.cookies.session) {
    res.status(403).render('simple-message', { message: 'Invalid session' });
    return;
  }

  const {
    genaiChatCompletionsApiEndpoint,
    genaiApiKey,
    genaiModel,
    instructionPrompt,
    judgeSince
  } = req.body;

  const configFile =
    configFileFormat.replace(/{session}/g, req.cookies.session);
  const config = await loadJson(configFile) ?? {};
  config.genai = {
    chatCompletionsApiEndpoint: genaiChatCompletionsApiEndpoint,
    apiKey: genaiApiKey,
    model: genaiModel
  };
  config.instructionPrompt = instructionPrompt;
  await dumpJson(config, configFile);

  const socialFile =
    socialFileFormat.replace(/{session}/g, req.cookies.session);
  const social = await loadJson(socialFile);
  await dumpJson(social, socialFile);

  const stateFile =
    stateFileFormat.replace(/{session}/g, req.cookies.session);
  const state = await loadJson(stateFile) ?? {};
  state.judgeSince = judgeSince;
  await dumpJson(state, stateFile);

  res.render('simple-message', { message: 'Successfully updated' });
});

async function refreshSession(social: any) {
  const refreshSessionResp = await fetch(
    social.provider + '/xrpc/com.atproto.server.refreshSession',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + social.session.refreshJwt }
    }
  );
  if (!refreshSessionResp.ok) {
    const { error, message } = await refreshSessionResp.json();
    throw new Error(error + ': ' + message);
  }
  const session = await refreshSessionResp.json();
  social.session.accessJwt = session.accessJwt;
  social.session.refreshJwt = session.refreshJwt;
  social.session.handle = session.handle;
  if (session.didDoc) social.session.didDoc = session.didDoc;
  if (session.active) social.session.active = session.active;
  if (session.status) social.session.status = session.status;

  const getProfileResp = await fetch(
    social.provider + '/xrpc/app.bsky.actor.getProfile?actor=' + session.did,
    {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + session.accessJwt }
    }
  );
  if (!getProfileResp.ok) {
    const { error, message } = await getProfileResp.json();
    throw new Error(error + ': ' + message);
  }
  const profile = await getProfileResp.json();
  social.profile = profile;

  social.lastSessionUpdated = new Date();

  return social;
}

function runRefreshSessionTask(
  options = { heartbeats: [5000, 10000, 15000, 20000] }
) {
  const delay =
    options.heartbeats[Math.floor(Math.random() * options.heartbeats.length)];
  setTimeout(async () => {
    console.info('Run refresh session task');

    try {
      for await (
        const { session, social: { file, data: social } } of iterSessionDir()
      ) {
        const refreshDate = new Date(
          new Date(social.lastSessionUpdated).getTime() + socialSessionAge
        );
        if (refreshDate > new Date()) continue;
        console.debug('Attempt to refresh session', session);
        await refreshSession(social);
        await dumpJson(social, file);
      }
    } catch (err) {
      console.error(err);
    }

    console.info('Finish refresh session task');

    runRefreshSessionTask(options);
  }, delay);
}
runRefreshSessionTask();

async function getJudgeTargetPost({ social, state }: any) {
  const listPostsUrl = new URL(
    '/xrpc/app.bsky.feed.getAuthorFeed',
    social.data.provider
  );
  listPostsUrl.searchParams.set('actor', social.data.profile.did);
  // listPostsUrl.searchParams.set('limit', '2');  // for debug
  if (state.data.cursor)
    listPostsUrl.searchParams.set('cursor', state.data.cursor);

  let completed = false;
  let targetPost;
  let contender1;
  let contender2;
  while (!completed) {
    const resp = await fetch(
      listPostsUrl,
      {
        headers: { Authorization: 'Bearer ' + social.data.session.accessJwt }
      }
    );
    if (!resp.ok) {
      const { error, message } = await resp.json();
      throw new Error(error + ': ' + message);
    }
    // posts in feed in descending order
    const { feed, cursor } = await resp.json();
    if (feed.length === 0) {
      completed = true;
      break;
    }
    for (const { post } of feed) {
      post.record.createdAt = new Date(post.record.createdAt);
      if (post.record.createdAt < state.data.judgeSince) {
        targetPost = contender1?.post;
        state.data.cursor = contender2?.cursor;
        completed = true;
        break;
      }
      contender2 = contender1;
      contender1 = { post, cursor };
    }
    if (!cursor) {  // last fetch
      targetPost = contender1?.post;
      state.data.cursor = contender2?.cursor;
      break;
    }
    listPostsUrl.searchParams.set('cursor', cursor);
  };

  return targetPost;
}

function runJudgeTask(frequency: number, options = { heartbeats: [5000, 10000, 15000, 20000] }) {
  const delay =
    options.heartbeats[Math.floor(Math.random() * options.heartbeats.length)];
  setTimeout(async () => {
    console.info('Run judge task');
    for await (
      const { session, social, config, state, logs } of iterSessionDir()
    ) {
      if (!state.data.judgeSince) continue;
      state.data.judgeSince = new Date(state.data.judgeSince);
      if (state.data.lastJudgeAttempted) {
        state.data.lastJudgeAttempted =
          new Date(state.data.lastJudgeAttempted);
        const nextJudgeAttempt =
          new Date(state.data.lastJudgeAttempted.getTime() + frequency);
        if (nextJudgeAttempt > new Date()) continue;
      }
      try {
        const targetPost = await getJudgeTargetPost({ social, state });
        if (targetPost) {
          console.debug('# target post', JSON.stringify(targetPost, null, 2));
          console.debug('Judge post');
          await judge({
            social: social.data,
            config: config.data,
            logs: logs,
            post: targetPost
          });
          state.data.judgeSince =
            new Date(targetPost.record.createdAt.getTime() + 1);
        }
        state.data.lastJudgeAttempted = new Date();
        await dumpJson(state.data, state.file);
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        console.warn(`Session: ${session}:`, e);
      }
    }
    console.log('Finish judge task');
    runJudgeTask(frequency, options);
  }, delay);
}
runJudgeTask(judgeFrequency);

app.listen(
  process.env.PORT,
  () => console.info('App listening on port', process.env.PORT)
).on('error', error => { throw new Error(error.message) });
