import { parse } from "https://deno.land/std/flags/mod.ts";
import * as path from "https://deno.land/std/path/mod.ts";
import * as log from "https://deno.land/std/log/mod.ts";
import * as fs  from "https://deno.land/std/fs/mod.ts";
import { createHash } from "https://deno.land/std/hash/mod.ts";

import { textTable } from "./textTable.ts";

import * as A from './adl-gen/dnt/manifest.ts';
import { Manifest, TaskManifest } from "./manifest.ts";

const manifest = new Manifest();

/// All tasks by name
const taskRegister = new Map<A.TaskName, Task>();

/// Tasks by target
const targetRegister = new Map<A.TrackedFileName, Task>();

/// Done or up-to-date tasks
const doneTasks = new Set<Task>();

/// In progress tasks
const inprogressTasks = new Set<Task>();

export type Action = () => Promise<void>|void;
export type IsUpToDate = () => Promise<boolean>|boolean;
export type GetFileHash = (filename: A.TrackedFileName) => Promise<A.TrackedFileHash>|A.TrackedFileHash;
export type GetFileTimestamp = (filename: A.TrackedFileName) => Promise<A.Timestamp>|A.Timestamp;

export type TaskParams = {
  name: A.TaskName;
  description?: string;
  action: Action;
  task_deps?: Task[];
  file_deps?: TrackedFile[];
  deps?: (Task|TrackedFile)[];
  targets?: TrackedFile[];
  uptodate?: IsUpToDate;
};

/// Convenience function: an up to date always false to run always
export const runAlways : IsUpToDate = async ()=>false;

export class Task {
  name: A.TaskName;
  description?: string;
  action: Action;
  task_deps: Set<Task>;
  file_deps: Set<TrackedFile>;
  targets: Set<TrackedFile>;

  taskManifest : TaskManifest|null = null;
  uptodate: IsUpToDate;

  constructor(taskParams: TaskParams) {
    this.name = taskParams.name;
    this.action = taskParams.action;
    this.description = taskParams.description;
    this.task_deps = new Set(this.getTaskDeps(taskParams.task_deps, taskParams.deps));
    this.file_deps = new Set(this.getTrackedFiles(taskParams.file_deps, taskParams.deps));
    this.targets = new Set(taskParams.targets || []);
    this.uptodate = taskParams.uptodate || runAlways;
  }

  private isTask = (dep: Task|TrackedFile) : dep is Task => {
    return dep instanceof Task;
  }
  private isTrackedFile = (dep: Task|TrackedFile) : dep is TrackedFile => {
    return dep instanceof TrackedFile;
  }

  private getTaskDeps(task_deps?: Task[], deps?: (Task|TrackedFile)[]) : Task[] {
    return (task_deps || []).concat( (deps || []).filter(this.isTask) );
  }
  private getTrackedFiles(file_deps?: TrackedFile[], deps?: (Task|TrackedFile)[]) : TrackedFile[] {
    return (file_deps || []).concat( (deps || []).filter(this.isTrackedFile) );
  }

  async setup() : Promise<void> {
    for(const t of this.targets) {
      targetRegister.set(t.path, this);
    }

    this.taskManifest = manifest.tasks.getOrInsert(this.name, new TaskManifest({
      trackedFiles: []
    }));
  }

  async exec(): Promise<void> {
    if(doneTasks.has(this)) {
      return;
    }
    if(inprogressTasks.has(this)) {
      return;
    }

    inprogressTasks.add(this);

    // add task dep on the task that makes the file if its a target
    for(const fd of this.file_deps) {
      const t = targetRegister.get(fd.path);
      if(t!==undefined) {
        this.task_deps.add(t);
      }
    }

    await this.execDependencies();

    let actualUpToDate = true;

    actualUpToDate = actualUpToDate && await this.checkFileDeps();
    log.info(`${this.name} checkFileDeps ${actualUpToDate}`);

    actualUpToDate = actualUpToDate && await this.targetsExist();
    log.info(`${this.name} targetsExist ${actualUpToDate}`);

    actualUpToDate = actualUpToDate && await this.uptodate();
    log.info(`${this.name} uptodate ${actualUpToDate}`);

    if(actualUpToDate) {
      log.info(`--- ${this.name}`);
    } else {
      log.info(`starting ${this.name}`);
      await this.action();
      log.info(`completed ${this.name}`);

      {
        /// recalc & save data of deps:
        let promisesInProgress: Promise<void>[] = [];
        for (const fdep of this.file_deps) {
          const p = fdep.getFileData().then(x=>{
            this.taskManifest?.setFileData(fdep.path, x);
          });
        }
        await Promise.all(promisesInProgress);
      }
    }

    doneTasks.add(this);
    inprogressTasks.delete(this);
  }

  private async targetsExist() : Promise<boolean> {
    const tex = await Promise.all( Array.from(this.targets).map(async tf=>tf.exists()));
    // all exist: NOT some NOT exist
    return !tex.some(t=>!t);
  }

  private async checkFileDeps() : Promise<boolean> {
    let fileDepsUpToDate = true;
    let promisesInProgress: Promise<void>[] = [];

    const taskManifest = this.taskManifest!;

    for (const fdep of this.file_deps) {
      const p = fdep.getFileDataOrCached(taskManifest.getFileData(fdep.path))
      .then(r=>{
        taskManifest.setFileData(fdep.path, r.tData);
        return r.upToDate;
      })
      .then(uptodate => {
        fileDepsUpToDate = fileDepsUpToDate && uptodate;
      });

      promisesInProgress.push(p.then(() => { }));
    }
    await Promise.all(promisesInProgress);
    promisesInProgress = [];
    return fileDepsUpToDate;
  }

  private async execDependencies() {
    let promisesInProgress: Promise<void>[] = [];
    for (const dep of this.task_deps) {
      if (!doneTasks.has(dep) && !inprogressTasks.has(dep)) {
        promisesInProgress.push(dep.exec());
      }
    }
    await Promise.all(promisesInProgress);
    promisesInProgress = [];
  }
}

export class TrackedFile {
  path: A.TrackedFileName = "";
  gethash: GetFileHash = filehash;

  constructor(fileParams : FileParams) {
    this.path = path.posix.resolve(fileParams.path);
    this.gethash = fileParams.gethash || filehash;
  }

  async getTimestamp() : Promise<A.Timestamp> {
    try {
      const stat = await Deno.lstat(this.path);
      const mtime = stat.mtime;
      return mtime?.toISOString() || "";
    }
    catch(err) {
      if(err instanceof Deno.errors.NotFound) {
        return "";
      }
      throw err;
    }
  }

  async exists() {
    log.info(`checking exists ${this.path}`);
    return fs.exists(this.path);
  }

  async getHash() {
    if(!await this.exists()) {
      return "";
    }

    log.info(`checking hash on ${this.path}`);
    return this.gethash(this.path);
  }

  /// whether this is up to date w.r.t. the given TrackedFileData
  async isUpToDate(tData: A.TrackedFileData|undefined) : Promise<boolean> {
    if(tData === undefined) {
      return false;
    }
    const mtime = await this.getTimestamp();
    if(mtime === tData.timestamp) {
      return true;
    }
    const hash = await this.getHash();
    return hash === tData.hash;
  }

  /// Recalculate timestamp and hash data
  async getFileData() : Promise<A.TrackedFileData> {
    return {
      hash: await this.getHash(),
      timestamp: await this.getTimestamp()
    };
  }

  /// return given tData if up to date or re-calculate
  async getFileDataOrCached(tData: A.TrackedFileData|undefined) : Promise<{
    tData: A.TrackedFileData,
    upToDate: boolean
  }> {
    if(tData !== undefined && await this.isUpToDate(tData)) {
      return {
        tData,
        upToDate: true
      };
    }
    return {
      tData: await this.getFileData(),
      upToDate: false
    };
  }
};

export const filehash = async (filename:string)=>{
  const str = await fs.readFileStr(filename);
  const hash = createHash("sha1");
  hash.update(str);
  const hashInHex = hash.toString();
  return hashInHex;
}

export type FileParams = {
  path: string;
  gethash?: GetFileHash;
};

/** Register a file for tracking */
export function file(fileParams: FileParams) : TrackedFile {
  return new TrackedFile(fileParams);
}

/** Register a task */
export function task(taskParams: TaskParams): Task {
  const task = new Task(taskParams);
  taskRegister.set(task.name, task);
  return task;
}

/** Execute given commandline args */
export async function exec(cliArgs: string[]) : Promise<void> {
  const args = parse(cliArgs);
  const taskName = `${args["_"][0]}`;


  if(taskName==='list') {

    console.log(textTable(['Name','Description'], Array.from(taskRegister.values()).map(t=>([
      t.name,
      t.description||""
    ]))));

    return;
  }

  await manifest.load();

  await Promise.all(Array.from(taskRegister.values()).map(t=>t.setup()));

  const task = taskRegister.get(taskName);
  if(task !== undefined) {
    await task.exec();
  } else {
    log.error(`task ${taskName} not found`);
  }

  await manifest.save();

  return;
}

// On execute of dnt as main, execute the user dnit.ts script
if(import.meta.main) {
  const proc = Deno.run({
    cmd: ["deno", "run", "--unstable", "--allow-read", "--allow-write", "--allow-run", "dnit.ts"].concat(Deno.args),
  });

  proc.status().then(st => {
    Deno.exit(st.code);
  })
}
