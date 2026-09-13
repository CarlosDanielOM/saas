import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { restoreAdminTheme } from './app/services/theme.service';

restoreAdminTheme();

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
