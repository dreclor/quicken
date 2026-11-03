import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './ui';
import {BridgeView} from './ui-bridge';
import {ChickenPopup} from './ui-popup';
import './style.css';
createRoot(document.getElementById('root')!).render(location.pathname==='/bridge'?<BridgeView/>:location.pathname==='/popup'?<ChickenPopup/>:<App/>);
