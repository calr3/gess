import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Log the exact date and time the page first loads.
console.log(`Page loaded: ${new Date().toString()}`);

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
