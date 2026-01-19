import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

type JoinMsg = { projectId: string; branchId?: string };
type PatchMsg = { projectId: string; branchId?: string; patch: any; clientTs?: number };

function roomOf(p: JoinMsg) {
  return p.branchId ? `project:${p.projectId}:branch:${p.branchId}` : `project:${p.projectId}`;
}

@WebSocketGateway({
  namespace: '/ws',
  cors: { origin: (process.env.WS_ORIGIN?.split(',') ?? ['http://localhost:4200']), credentials: true }
})
@Injectable()
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger('RealtimeGateway');

  @WebSocketServer() server!: Server;

  constructor(private jwt: JwtService, private prisma: PrismaService) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth as any)?.token ||
        (client.handshake.headers['authorization'] as string | undefined)?.split(' ')[1];

      if (!token) throw new Error('No token');
      const payload = this.jwt.verify(token, { secret: process.env.JWT_SECRET! });
      (client.data as any).userId = payload.sub || payload.userId;
      this.log.debug(`WS connect ${client.id} user:${(client.data as any).userId}`);
    } catch {
      client.disconnect(true);
    }
  }
  handleDisconnect(client: Socket) {
    this.log.debug(`WS disconnect ${client.id}`);
  }

  private async assertCanRead(userId: string, projectId: string) {
    const mem = await this.prisma.projectMember.findFirst({ where: { projectId, userId } });
    if (!mem) throw new Error('forbidden');
  }
  private async assertCanEdit(userId: string, projectId: string) {
    const mem = await this.prisma.projectMember.findFirst({ where: { projectId, userId, role: { in: ['OWNER','EDITOR'] } } });
    if (!mem) throw new Error('forbidden');
  }

@SubscribeMessage('join')
async onJoin(@MessageBody() data: JoinMsg, @ConnectedSocket() client: Socket) {
  const userId = (client.data as any).userId as string;
  await this.assertCanRead(userId, data.projectId);
  const room = roomOf(data);
  client.join(room);
  this.log.debug(`join user:${userId} room:${room}`);
  client.emit('joined', { room });
}

@SubscribeMessage('patch')
async onPatch(@MessageBody() msg: PatchMsg, @ConnectedSocket() client: Socket) {
  const userId = (client.data as any).userId as string;
  await this.assertCanEdit(userId, msg.projectId);
  const room = roomOf(msg);
  this.log.debug(`patch from:${client.id} room:${room}`);
  client.to(room).emit('patch', { patch: msg.patch, from: client.id, clientTs: msg.clientTs ?? Date.now() });
}


  // Opción: evento replace explícito
  @SubscribeMessage('replace')
  onReplace(@MessageBody() msg: PatchMsg, @ConnectedSocket() client: Socket) {
    const room = roomOf(msg);
    client.to(room).emit('replace', { model: msg.patch, from: client.id });
  }
}
