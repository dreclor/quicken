import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/browser',timeout:45_000,fullyParallel:false,workers:1,use:{baseURL:'http://127.0.0.1:4317',viewport:{width:1440,height:1000},trace:'retain-on-failure'},reporter:'list'});
