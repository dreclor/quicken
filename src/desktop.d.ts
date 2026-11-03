export {};
declare global {
  type MeetingDetection = { enabled: boolean; apps: string[]; error?: string };
  type QuickenNavigation = { view?: 'connections'; meetingId?: string };
  interface AudioContext {
    setSinkId(sinkId: string): Promise<void>;
  }
  interface Window {
    quickenDesktop?: {
      showMain(target?: QuickenNavigation): void;
      onNavigate(listener: (target: QuickenNavigation) => void): () => void;
      setChickenExpanded(expanded: boolean): void;
      showChicken(): void;
      closeChicken(): void;
      getDetection(): Promise<MeetingDetection>;
      setDetection(enabled: boolean): void;
      onDetection(listener: (state: MeetingDetection) => void): () => void;
    };
  }
}
