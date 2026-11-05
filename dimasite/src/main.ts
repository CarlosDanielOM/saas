import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { rememberExperiments } from './app/shared/utils/experiments';

rememberExperiments();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
