import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { PageConfig } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { Contents, ServerConnection } from '@jupyterlab/services';
import { ITranslator } from '@jupyterlab/translation';
import { IStateDB } from '@jupyterlab/statedb';
import { CommandRegistry } from '@lumino/commands';
import { each } from '@lumino/algorithm';
import { Signal } from '@lumino/signaling';
import { Menu } from '@lumino/widgets';


namespace CommandIDs {
  export const copyFile = 'filebrowser:copy';
  export const pasteFile = 'filebrowser:paste';
  export const copyPasteFile = 'jupyterlab-copy-to-recent:copypaste'; // todo
}


namespace PluginIDs {
  export const recents = 'jupyterlab-recents';
}

namespace StateIDs {
  export const recents = `${PluginIDs}:recents`;
}

namespace CommandIDs {
  export const openRecent = `${PluginIDs.recents}:open-recent`;
  export const clearRecents = `${PluginIDs.recents}:clear-recents`;
}

namespace types {
  export type Recent = {
    root: string;
    path: string;
    contentType: string;
  };
}

namespace utils {
  export function mergePaths(root: string, path: string): string {
    if (root.endsWith('/')) {
      root = root.slice(0, -1);
    }
    if (path.endsWith('/')) {
      path = path.slice(1);
    }
    return `${root}/${path}`;
  }
}

class RecentsManager {
  public recentsMenu: Menu;
  private recentsChanged = new Signal<this, types.Recent[]>(this);
  private serverRoot: string;
  private stateDB: IStateDB;
  private contentsManager: Contents.IManager;
  private _recents: types.Recent[];
  // Will store a Timemout call that saves recents changes after a delay
  private saveRoutine: any;
  // Will store a Timeout call that periodically runs to validate the recents
  private validator: any;
  // Whether there are local changes sent to be recorded without verification
  private awaitingSaveCompletion = false;

  constructor(
    commands: CommandRegistry,
    stateDB: IStateDB,
    contents: Contents.IManager
  ) {
    this.serverRoot = PageConfig.getOption('serverRoot');
    this.stateDB = stateDB;
    this.contentsManager = contents;
    // This menu will appear in the File menu
    this.recentsMenu = new Menu({ commands });
    this.recentsMenu.title.label = 'Copy to Recent';
    // Listen for updates to _recents
    this.recentsChanged.connect(_ => {
      this.syncRecentsMenu();
    });

    this._recents = [];
  }

  get recents(): types.Recent[] {
    const recents = this._recents || [];
    return recents.filter(r => r.root === this.serverRoot);
  }

  set recents(recents: types.Recent[]) {
    // Keep track of any recents pertaining to other roots
    const otherRecents = this._recents.filter(r => r.root !== this.serverRoot);
    const allRecents = recents
      .filter(r => r.root === this.serverRoot)
      .concat(otherRecents);
    this._recents = allRecents;
    this.saveRecents();
    this.recentsChanged.emit(this.recents);
  }

  async init() {
    await this.loadRecents();
    return this.validateRecents();
  }

  addRecent(path: string, contentType: string) {
    const recent: types.Recent = {
      root: this.serverRoot,
      path,
      contentType
    };
    console.log("adding recent", recent);
    const recents = this.recents;
    const directories = recents.filter(r => r.contentType === 'directory');
    const files = recents.filter(r => r.contentType !== 'directory');
    const destination = contentType === 'directory' ? directories : files;
    // Check if it's already present; if so remove it
    const existingIndex = destination.findIndex(r => r.path === path);
    if (existingIndex >= 0) {
      destination.splice(existingIndex, 1);
    }
    // Add to the front of the list
    destination.unshift(recent);
    // Keep up to 10 of each type of recent path
    if (destination.length > 10) {
      destination.pop();
    }

    console.log('destination', destination);
    console.log('recents', this.recents);
    this.recents = directories
  }

  removeRecents(paths: (string | null | undefined)[]) {
    const recents = this.recents;
    this.recents = recents.filter(r => paths.indexOf(r.path) === -1);
  }

  clearRecents() {
    this.recents = [];
  }

  async validateRecents() {
    clearTimeout(this.validator);
    // Unless triggered directly, recents will be validated every 12 seconds
    this.validator = setTimeout(this.validateRecents.bind(this), 12 * 1000);
    const recents = this.recents;
    const invalidPathsOrNulls = await Promise.all(
      recents.map(async r => {
        try {
          await this.contentsManager.get(r.path, { content: false });
          return null;
        } catch (e) {
          if ((e as ServerConnection.ResponseError).response?.status === 404) {
            return r.path;
          }
        }
      })
    );

    const invalidPaths = invalidPathsOrNulls.filter(x => (x !== undefined));
    if (invalidPaths.length > 0) {
      this.removeRecents(invalidPaths);
    }
  }

  syncRecentsMenu() {
    this.recentsMenu.clearItems();
    const recents = this.recents;
    const directories = recents.filter(r => r.contentType === 'directory');
    [directories].forEach(rs => {
      if (rs.length > 0) {
        rs.forEach(recent => {
          this.recentsMenu.addItem({
            command: CommandIDs.copyPasteFile,
            args: { recent },
          });
        });
        this.recentsMenu.addItem({ type: 'separator' });
      }
    });

  }

  async loadRecents() {
    const recents = await this.stateDB.fetch(StateIDs.recents);
    this._recents = (recents as types.Recent[]) || [];
    this.recentsChanged.emit(this.recents);
  }

  saveRecents() {
    clearTimeout(this.saveRoutine);
    // Save _recents 500 ms after the last time saveRecents has been called
    this.saveRoutine = setTimeout(async () => {
      // If there's a previous request pending, wait 500 ms and try again
      if (this.awaitingSaveCompletion) {
        this.saveRecents();
      } else {
        this.awaitingSaveCompletion = true;
        try {
          await this.stateDB.save(StateIDs.recents, this._recents);
          this.awaitingSaveCompletion = false;
        } catch (e) {
          this.awaitingSaveCompletion = false;
          console.log('Saving recents failed');
          // Try again
          this.saveRecents();
        }
      }
    }, 500);
  }
}


/**
 * Initialization data for the jupyterlab-copy-to-recent extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-copy-to-recent:plugin',
  description: 'Copy files to the most recently open folders',
  autoStart: true,

  requires: [IFileBrowserFactory, IDefaultFileBrowser, IStateDB, IDocumentManager],
  optional: [ITranslator],

  activate: (
    app: JupyterFrontEnd,
    factory: IFileBrowserFactory,
    defaultBrowser: IDefaultFileBrowser,
    stateDB: IStateDB,
    docManager: IDocumentManager,
    translator: ITranslator | null
  ) => {
    console.log(defaultBrowser);
    // const trans = (translator ?? nullTranslator).load('jupyter_archive');

    const { commands, serviceManager } = app;
    const { tracker } = factory;

    const recentsManager = new RecentsManager(
      commands,
      stateDB,
      serviceManager.contents
    );

    defaultBrowser.model.fileChanged.connect(async (_, args) => {

      if (args.type === 'new' || args.type === 'rename' || args.type === 'save') {

        if (args.newValue === null) {
          return;
        }
        const path = args.newValue.path;

        if (path === null) {
          return;
        }

        if (path === undefined) {
          return;
        }

        const item = await docManager.services.contents.get(path, {
          content: false
        });
        const fileType = app.docRegistry.getFileTypeForModel(item);
        const contentType = fileType.contentType;

        if (contentType === 'directory') {
          console.log("adding directory to recents", path, contentType);
          recentsManager.addRecent(path, 'directory');
        }

        // Add the containing directory
        if (contentType !== 'directory') {
          const parent =
            path.lastIndexOf('/') > 0 ? path.slice(0, path.lastIndexOf('/')) : '';
          recentsManager.addRecent(parent, 'directory');
        }
      console.log('recents list', recentsManager.recents);
      }

    }


    );

    // matches anywhere on filebrowser
    const selectorContent = '.jp-DirListing-content';


    // Add the 'copyToRecent' command to the file's menu.
    commands.addCommand(CommandIDs.copyPasteFile, {
      execute: args => {
        const widget = tracker.currentWidget;
        if (widget) {
          each(widget.selectedItems(), item => {
            console.log('copying from ', item.path);
            const recent = args.recent as types.Recent;
            console.log('copying to ', recent.path);

            // const recent_directory = utils.mergePaths(recent.root, recent.path);
            docManager.copy(item.path, utils.mergePaths(recent.path, item.name));
          });
        }
      },
      label: args => {
        const recent = args.recent as types.Recent;
        return recent.path;
      }
    });
    
    app.contextMenu.addItem({
      type: 'submenu' as Menu.ItemType,
      submenu: recentsManager.recentsMenu,
      selector: selectorContent,
      rank: 10
    });

    recentsManager.init();
    console.log('JupyterLab extension jupyterlab-copy-to-recent is activated!');
  }
};

export default plugin;
