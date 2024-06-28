import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

/**
 * Initialization data for the jlab-quick-copy extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jlab-quick-copy:plugin',
  description: 'Quickly copy files to most recently open folders',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    console.log('JupyterLab extension jlab-quick-copy is activated!');
  }
};

export default plugin;
