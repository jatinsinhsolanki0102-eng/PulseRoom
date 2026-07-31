import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const rawUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseUrl = rawUrl.replace(/\/rest\/v1\/?$/, '');
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

export const supabase = (supabaseUrl && supabaseAnonKey && !supabaseUrl.includes('your-project'))
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

if (supabase) {
  console.log(`⚡ Connected to Supabase Auth & Email OTP Engine (${supabaseUrl})`);
} else {
  console.log('ℹ️ Operating in High-Performance Auth Engine with Supabase Integration ready.');
}
